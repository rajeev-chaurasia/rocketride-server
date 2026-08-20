# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
HTTP request execution engine.

Accepts a fully-specified request descriptor (URL, method, headers, auth, body,
params) and returns a structured response dict.  Uses the ``requests`` library.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import time
from typing import Any, Dict, Optional
from urllib.parse import quote, urlsplit

import requests
from requests.auth import HTTPBasicAuth

DEFAULT_TIMEOUT_SECONDS = 30
MAX_TIMEOUT_SECONDS = 300


def execute_request(
    *,
    url: str,
    method: str,
    query_params: Optional[Dict[str, str]] = None,
    path_params: Optional[Dict[str, str]] = None,
    headers: Optional[Dict[str, str]] = None,
    auth: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Execute an HTTP request and return a structured response.

    Raises ``requests.RequestException`` on transport-level failures.
    """
    resolved_url = _resolve_path_params(url, path_params)
    _validate_public_url(resolved_url)

    req_headers = dict(headers or {})
    req_auth = None
    extra_params: Dict[str, str] = {}

    _apply_auth(auth, req_headers, extra_params, req_auth_out := [None])
    req_auth = req_auth_out[0]

    merged_params = dict(query_params or {})
    merged_params.update(extra_params)

    req_kwargs: Dict[str, Any] = {
        'method': method.upper(),
        'url': resolved_url,
        'headers': req_headers,
        'params': merged_params or None,
        'auth': req_auth,
        # Redirect targets have not passed the URL whitelist or network-address
        # checks. Return 3xx responses to the caller instead of following them.
        'allow_redirects': False,
    }

    _apply_body(body, req_headers, req_kwargs)

    if timeout is not None and timeout > 0:
        req_kwargs['timeout'] = min(timeout, MAX_TIMEOUT_SECONDS)
    else:
        req_kwargs['timeout'] = DEFAULT_TIMEOUT_SECONDS

    start = time.monotonic()
    resp = requests.request(**req_kwargs)
    elapsed_ms = round((time.monotonic() - start) * 1000)

    return _build_response(resp, elapsed_ms)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _validate_public_url(url: str) -> None:
    """Reject malformed URLs and destinations outside the public Internet."""
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {'http', 'https'}:
        raise ValueError('URL scheme must be http or https')
    if not parsed.hostname:
        raise ValueError('URL must include a hostname')

    try:
        parsed_port = parsed.port
    except ValueError:
        raise ValueError('URL port is invalid') from None
    port = parsed_port if parsed_port is not None else (443 if parsed.scheme.lower() == 'https' else 80)
    if port == 0:
        raise ValueError('URL port is invalid')

    try:
        resolved = socket.getaddrinfo(
            parsed.hostname,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    except socket.gaierror:
        raise requests.ConnectionError(f'URL hostname {parsed.hostname!r} could not be resolved') from None

    if not resolved:
        raise requests.ConnectionError(f'URL hostname {parsed.hostname!r} could not be resolved')

    for _family, _socktype, _proto, _canonname, sockaddr in resolved:
        raw_address = sockaddr[0].split('%', 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError:
            raise requests.ConnectionError(
                f'URL hostname {parsed.hostname!r} resolved to an invalid network address'
            ) from None
        if not _is_public_address(address):
            raise ValueError(f'URL hostname {parsed.hostname!r} resolves to a non-public network address')


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return whether an address is safe for an Internet-only HTTP client."""
    if not address.is_global or address.is_multicast:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        return True
    if address.is_site_local or address in ipaddress.IPv6Network('::/96'):
        return False

    embedded = []
    if address.ipv4_mapped is not None:
        embedded.append(address.ipv4_mapped)
    if address.sixtofour is not None:
        embedded.append(address.sixtofour)
    if address.teredo is not None:
        embedded.extend(address.teredo)
    return all(item.is_global and not item.is_multicast for item in embedded)


def _resolve_path_params(url: str, path_params: Optional[Dict[str, str]]) -> str:
    """Replace ``:name`` placeholders in the URL with values from *path_params*."""
    if not path_params:
        return url
    resolved = url
    for key, value in path_params.items():
        # Encode (safe='') so the value stays one path segment and cannot slip
        # past the URL allowlist, which is checked against the unresolved
        # template. The function replacement keeps it literal (no re.sub
        # backslash/group-ref interpretation, e.g. '\1' -> re.error).
        replacement = quote(str(value), safe='')
        resolved = re.sub(rf':{re.escape(key)}\b', lambda _m, r=replacement: r, resolved)
    return resolved


def _apply_auth(
    auth: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    extra_params: Dict[str, str],
    req_auth_out: list,
) -> None:
    """Mutate *headers* / *extra_params* / *req_auth_out* based on auth config."""
    if not auth:
        return
    auth_type = (auth.get('type') or 'none').strip().lower()
    if auth_type == 'none':
        return

    if auth_type == 'basic':
        basic = auth.get('basic') or {}
        req_auth_out[0] = HTTPBasicAuth(
            basic.get('username', ''),
            basic.get('password', ''),
        )

    elif auth_type == 'bearer':
        bearer = auth.get('bearer') or {}
        token = bearer.get('token', '')
        headers['Authorization'] = f'Bearer {token}'

    elif auth_type == 'api_key':
        api_key = auth.get('api_key') or {}
        key = api_key.get('key', '')
        value = api_key.get('value', '')
        add_to = (api_key.get('add_to') or 'header').strip().lower()
        if add_to == 'query_param':
            extra_params[key] = value
        else:
            headers[key] = value


def _apply_body(
    body: Optional[Dict[str, Any]],
    headers: Dict[str, str],
    req_kwargs: Dict[str, Any],
) -> None:
    """Populate *req_kwargs* with the appropriate body payload."""
    if not body:
        return
    body_type = (body.get('type') or 'none').strip().lower()
    if body_type == 'none':
        return

    if body_type == 'raw':
        raw = body.get('raw') or {}
        content = raw.get('content', '')
        content_type = raw.get('content_type', 'application/json')
        headers.setdefault('Content-Type', content_type)
        req_kwargs['data'] = content

    elif body_type == 'form_data':
        form_data = body.get('form_data') or {}
        # multipart/form-data: pass each field as a tuple so ``requests``
        # builds the multipart envelope automatically.
        req_kwargs['files'] = {k: (None, v) for k, v in form_data.items()}

    elif body_type == 'x_www_form_urlencoded':
        urlencoded = body.get('urlencoded') or {}
        req_kwargs['data'] = urlencoded


def _build_response(resp: requests.Response, elapsed_ms: int) -> Dict[str, Any]:
    """Convert a ``requests.Response`` into a structured dict for the agent."""
    content_type = resp.headers.get('Content-Type', '')

    parsed_json = None
    if 'json' in content_type or 'javascript' in content_type:
        try:
            parsed_json = resp.json()
        except Exception:
            pass

    return {
        'status_code': resp.status_code,
        'status_text': resp.reason or '',
        'headers': dict(resp.headers),
        'body': resp.text,
        'json': parsed_json,
        'elapsed_ms': elapsed_ms,
        'content_type': content_type,
    }
