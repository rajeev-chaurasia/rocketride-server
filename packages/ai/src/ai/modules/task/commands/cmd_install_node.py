# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
InstallNodeCommands: DAP handler for ``rrext_install_node`` — the capsule launcher.

Installs a self-contained node capsule (``.rrc``) into the caller's store so it
becomes usable in pipelines, without restarting the engine:

    client (VSCode / SaaS web)  --rrext_install_node-->  engine
        1. AIRLOCK (mandatory)  — validate_capsule(); reject before anything persists
        2. STORE WRITE          — user's joined filesystem (#1686), local_nodes/<name>/
        3. DEPENDS              — install the node's pinned requirements.txt
        --> catalog overlay picks it up live (cmd_misc.on_rrext_services)
        --> per-run child loads it from the store (task_engine node_path materialization)

Secure-first: nothing is written to the store and no dependency is installed
until the airlock passes.
"""

import asyncio
import base64
import json
import posixpath
from typing import Any, Dict

from ai.common.dap.dap_conn import DAPConn

from .capsule_airlock import NODES_ROOT, AirlockRejected, CapsuleInfo, validate_capsule

# Root (relative to the caller's file area) under which installed node capsules
# live. Matches the capsule's internal ``local_nodes/`` layout and the path the
# catalog overlay and per-run materializer read back from.
STORE_NODES_ROOT = 'local_nodes'

# The installed copy of the capsule's manifest, kept beside the node's files.
# The store holds the node payload only, so without this the capsule's version
# and declared capabilities would be lost and no export could rebuild the
# original. Dot-prefixed and skipped when re-packing, so it never becomes part
# of the payload it describes.
STORE_MANIFEST_NAME = '.capsule.json'


def _safe_node_name(raw: Any) -> str:
    """
    Narrow a caller-supplied node name to a single dir under ``local_nodes/``.

    Rejects empty, path separators and dot segments, so a name can never escape
    the root. Returns '' when the name is unusable.
    """
    name = str(raw or '').strip()
    if not name or '/' in name or '\\' in name or name in ('.', '..'):
        return ''
    return name


class InstallNodeCommands(DAPConn):
    """DAP router for ``rrext_install_node`` — install a node capsule into the caller's store."""

    def __init__(self, connection_id: int, server: 'TaskServer', transport, **kwargs) -> None:  # noqa: F821
        """No per-command state; identity/store access come from the other TaskConn mixins."""
        pass

    async def on_rrext_install_node(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Install a node capsule for the authenticated caller.

        Arguments (in ``request['arguments']``):
            capsule (str): base64-encoded ``.rrc`` bytes (primary path), OR
            path (str):    store path to an already-uploaded ``.rrc``.

        Returns a DAP response whose body is either
            {'ok': True, 'installed': <name>, 'protocol': <p>, 'version': <v>} or
            {'ok': False, 'violations': [...]}  when the airlock rejects it.
        """
        args = request.get('arguments') or {}
        try:
            zip_bytes = await self._resolve_capsule_bytes(args)

            # 1. AIRLOCK — mandatory gate. On rejection nothing else runs.
            try:
                info = validate_capsule(zip_bytes)
            except AirlockRejected as rej:
                self.debug_message(f'Capsule rejected by airlock: {rej.violations}')
                return self.build_response(request, body={'ok': False, 'violations': rej.violations})

            # 2. STORE WRITE — into the caller's joined filesystem (#1686).
            await self._write_capsule_to_store(info)

            # 3. DEPENDS — install the node's pinned requirements into the shared env.
            await self._install_requirements(info)

            self.debug_message(f'Installed node capsule {info.name!r} ({info.protocol})')
            return self.build_response(
                request,
                body={'ok': True, 'installed': info.name, 'protocol': info.protocol, 'version': info.version},
            )
        except Exception as e:
            self.debug_message(f'rrext_install_node failed: {e}')
            raise

    async def on_rrext_uninstall_node(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Uninstall a previously-installed node capsule for the authenticated caller.

        Arguments (in ``request['arguments']``):
            node (str): the installed node's name (its ``local_nodes/<name>/`` dir).

        Removes the node's dir from the caller's store. The catalog overlay re-reads
        the store on the next ``rrext_services``, so the node then disappears — no
        cache to invalidate. Returns {'ok': True, 'uninstalled': <name>} or
        {'ok': False, 'error': <why>}.
        """
        args = request.get('arguments') or {}
        # Confine the delete to a single dir directly under local_nodes/.
        name = _safe_node_name(args.get('node'))
        if not name:
            return self.build_response(request, body={'ok': False, 'error': 'invalid node name'})
        try:
            from ai.account import Store

            fs = Store.file_store(self.request_context())
            await fs.rmdir(f'{STORE_NODES_ROOT}/{name}', recursive=True)
            self.debug_message(f'Uninstalled node capsule {name!r}')
            return self.build_response(request, body={'ok': True, 'uninstalled': name})
        except Exception as e:
            self.debug_message(f'rrext_uninstall_node failed: {e}')
            return self.build_response(request, body={'ok': False, 'error': str(e)})

    async def on_rrext_export_node(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Re-pack an installed node capsule so the caller can save it as a ``.rrc``.

        The round-trip half of ``rrext_install_node``: reads the node back out of
        the caller's store, rebuilds the manifest from the copy kept at install
        time (see STORE_MANIFEST_NAME), and re-packs. The result passes the
        airlock again — the checksum is recomputed over the payload that is
        actually there, so a node edited in place exports as a valid capsule.

        Arguments (in ``request['arguments']``):
            node (str): the installed node's name.

        Returns {'ok': True, 'node': <name>, 'filename': '<name>.rrc',
        'capsule': <base64>} or {'ok': False, 'error': <why>}.
        """
        args = request.get('arguments') or {}
        name = _safe_node_name(args.get('node'))
        if not name:
            return self.build_response(request, body={'ok': False, 'error': 'invalid node name'})
        try:
            from ai.account import Store

            from .capsule_airlock import load_relaxed_json
            from .capsule_pack import pack_payload

            fs = Store.file_store(self.request_context())
            node_dir = f'{STORE_NODES_ROOT}/{name}'
            files = await self._read_store_tree(fs, node_dir)
            if not files:
                return self.build_response(request, body={'ok': False, 'error': f'node {name!r} is not installed'})

            # The manifest is metadata ABOUT the payload, so it is stripped
            # before packing and re-emitted by pack_payload().
            manifest_raw = files.pop(STORE_MANIFEST_NAME, None)
            manifest = json.loads(manifest_raw.decode('utf-8')) if manifest_raw else {}

            services_raw = files.get('services.json')
            services = load_relaxed_json(services_raw.decode('utf-8')) if services_raw else {}
            protocol = manifest.get('protocol') or services.get('protocol') or f'{name}://'

            payload = {f'{NODES_ROOT}/{name}/{rel}': data for rel, data in files.items()}
            capsule = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: pack_payload(
                    name,
                    payload,
                    protocol,
                    version=str(manifest.get('version') or '0.0.0'),
                    declares=list(manifest.get('declares') or []),
                ),
            )
            self.debug_message(f'Exported node capsule {name!r} ({len(capsule)} bytes)')
            return self.build_response(
                request,
                body={
                    'ok': True,
                    'node': name,
                    'filename': f'{name}.rrc',
                    'capsule': base64.b64encode(capsule).decode('ascii'),
                },
            )
        except Exception as e:
            self.debug_message(f'rrext_export_node failed: {e}')
            return self.build_response(request, body={'ok': False, 'error': str(e)})

    # -------------------------------------------------------------------------

    async def _read_store_tree(self, fs, root: str) -> Dict[str, bytes]:
        """
        Read every file under a store directory, keyed by path relative to it.

        Walks depth-first through ``list_dir`` (which only reports immediate
        children). A missing root yields an empty dict rather than raising —
        the caller reports it as "not installed".
        """
        out: Dict[str, bytes] = {}
        try:
            listing = await fs.list_dir(root)
        except Exception:
            return out
        for entry in listing.get('entries', []) if isinstance(listing, dict) else []:
            child = entry.get('name') if isinstance(entry, dict) else entry
            if not child:
                continue
            path = f'{root}/{child}'
            if isinstance(entry, dict) and entry.get('type') == 'dir':
                for rel, data in (await self._read_store_tree(fs, path)).items():
                    out[f'{child}/{rel}'] = data
            else:
                out[child] = await self._read_store_bytes(fs, path)
        return out

    async def _read_store_bytes(self, fs, path: str) -> bytes:
        """Read a whole store file through the chunked handle API."""
        meta = await fs.open_read(path)
        handle = meta['handle']
        data = bytearray()
        offset = 0
        try:
            while True:
                chunk = await fs.read_chunk(handle, offset)
                if not chunk:
                    break
                data.extend(chunk)
                offset += len(chunk)
        finally:
            await fs.close_read(handle)
        return bytes(data)

    async def _resolve_capsule_bytes(self, args: Dict[str, Any]) -> bytes:
        """Get the raw .rrc bytes from a base64 payload or an uploaded store path."""
        b64 = args.get('capsule')
        if b64:
            try:
                return base64.b64decode(b64)
            except (ValueError, TypeError) as exc:
                raise ValueError(f'"capsule" is not valid base64: {exc}')

        path = args.get('path')
        if path:
            from ai.account import Store

            fs = Store.file_store(self.request_context())
            meta = await fs.open_read(path)
            handle = meta['handle']
            chunks = bytearray()
            offset = 0
            try:
                while True:
                    chunk = await fs.read_chunk(handle, offset)
                    if not chunk:
                        break
                    chunks.extend(chunk)
                    offset += len(chunk)
            finally:
                await fs.close_read(handle)
            return bytes(chunks)

        raise ValueError('rrext_install_node requires "capsule" (base64) or "path"')

    async def _write_capsule_to_store(self, info: CapsuleInfo) -> None:
        """Persist the validated capsule files under the caller's ``local_nodes/<name>/``."""
        from ai.account import Store

        fs = Store.file_store(self.request_context())

        # Replace any prior install of this node so re-uploads are idempotent.
        node_dir = f'{STORE_NODES_ROOT}/{info.name}'
        try:
            await fs.rmdir(node_dir, recursive=True)
        except Exception:
            pass  # first install: nothing to remove

        # The node's payload, plus the manifest that describes it (see
        # STORE_MANIFEST_NAME) so an export can rebuild an equivalent capsule.
        manifest = json.dumps(
            {'name': info.name, 'protocol': info.protocol, 'version': info.version, 'declares': list(info.declares)},
            indent=2,
            sort_keys=True,
        ).encode('utf-8')
        to_write = dict(info.files)
        to_write[f'{node_dir}/{STORE_MANIFEST_NAME}'] = manifest

        made: set = set()
        for arc in sorted(to_write):
            parent = posixpath.dirname(arc)
            if parent and parent not in made:
                await fs.mkdir(parent)
                made.add(parent)
            handle = await fs.open_write(arc)
            try:
                await fs.write_chunk(handle, to_write[arc])
            finally:
                await fs.close_write(handle)

    async def _install_requirements(self, info: CapsuleInfo) -> None:
        """Install the node's pinned requirements.txt (if any) into the shared engine env."""
        req_arc = f'{info.node_dir}/requirements.txt'
        req_bytes = info.files.get(req_arc)
        if not req_bytes or not req_bytes.strip():
            return

        import os
        import tempfile

        from depends import depends  # type: ignore

        with tempfile.TemporaryDirectory(prefix=f'capsule-{info.name}-') as tmp:
            req_path = os.path.join(tmp, 'requirements.txt')
            with open(req_path, 'wb') as fh:
                fh.write(req_bytes)
            # depends() is synchronous (bootstraps uv/pip); keep the loop free.
            await asyncio.get_event_loop().run_in_executor(None, depends, req_path)
