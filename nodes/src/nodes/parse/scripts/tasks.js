// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Build tasks for the parse node's java library
 *
 * Commands:
 *   build - Build the tika jar and copy to dist
 *   clean - Remove build artifacts
 */
const path = require('path');
const {
    syncDir, formatSyncStats,
    removeDirs, removeFile, BUILD_ROOT, DIST_ROOT,
    exists, readFile, writeFile, syncFile
} = require('../../../../../scripts/lib');
const { execMaven } = require('../../../../../packages/java/scripts/tasks');

// The tika release this node parses with
const TIKA_VERSION = '3.2.3';

const PACKAGE_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(DIST_ROOT, 'server', 'java');
const BUILD_DIR = path.join(BUILD_ROOT, 'parse');

// Glob patterns to ignore when syncing
const IGNORE = ['**/target/**', '**/node_modules/**', '**/.git/**', '**/scripts/**', '**/lib/parse/pom.xml'];

// ============================================================================
// Action Factories
// ============================================================================

function makeSyncSourceAction(options = {}) {
    return {
        locks: ['parse'],
        run: async (ctx, task) => {
            task.output = 'Scanning for changes...';
            const stats = await syncDir(path.join(PACKAGE_DIR, 'lib'),
                                        path.join(BUILD_DIR, 'lib'), { ignore: IGNORE });
            task.output = formatSyncStats(stats);
            ctx.parseSourceChanged = stats.changed > 0;
        }
    };
}

function makeBuildJarAction(options = {}) {
    const buildParseDir = path.join(BUILD_DIR, 'lib', 'parse');
    const distParseJar = path.join(DIST_DIR, 'lib', 'rocketride-parse.jar');

    return {
        locks: ['parse', 'maven'],
        run: async (ctx, task) => {
            // Skip if already built
            if (!options.force && !ctx.parseSourceChanged && await exists(distParseJar)) {
                task.output = 'Already built';
                return;
            }


            // Generate pom.xml from template
            const pomTemplate = await readFile(path.join(buildParseDir, 'pom-template.xml'));
            let osClassifier;
            if (process.platform === 'win32') osClassifier = 'win-x86_64';
            else if (process.platform === 'darwin') osClassifier = 'osx-x86_64';
            else osClassifier = 'linux-x86_64';

            const pomContent = pomTemplate
                .replace(/@ROCKETRIDE_TIKA_VERSION@/g, TIKA_VERSION)
                .replace(/@ROCKETRIDE_OPERATING_SYSTEM@/g, osClassifier);
            await writeFile(path.join(buildParseDir, 'pom.xml'), pomContent);

            task.output = 'Generated pom.xml, building...';

            // includeScope=runtime skips the log4j jars rocketride-core ships
            await execMaven(['clean', 'compile', 'package', 'dependency:copy-dependencies',
                             '-DincludeScope=runtime', '-q'],
                            { task, cwd: buildParseDir });
        }
    };
}

function makeTestJarAction() {
    const buildParseDir = path.join(BUILD_DIR, 'lib', 'parse');

    return {
        locks: ['maven'],
        run: async (_ctx, task) => {
            await execMaven(['test', '-q'], { task, cwd: buildParseDir });
        }
    };
}

function makeCopyOutputsAction(options = {}) {
    const buildParseDir = path.join(BUILD_DIR, 'lib', 'parse');
    const distParseJar = path.join(DIST_DIR, 'lib', 'rocketride-parse.jar');

    return {
        locks: ['parse'],
        run: async (ctx, task) => {
            // Skip if already copied
            if (!options.force && !ctx.parseSourceChanged && await exists(distParseJar)) {
                task.output = 'Already copied';
                return;
            }


            const libDir = path.join(DIST_DIR, 'lib');

            // Copy tika-config.xml
            const tikaConfig = path.join(buildParseDir, 'tika-config.xml');
            await syncFile(tikaConfig, path.join(DIST_DIR, 'tika-config.xml'), { package: true });

            // Copy the parse jar
            const tikaJar = path.join(buildParseDir, 'target', `rocketride-parse-${TIKA_VERSION}.jar`);
            await syncFile(tikaJar, distParseJar, { package: true });

            // Copy tika dependencies
            await syncDir(path.join(buildParseDir, 'target', 'dependency'), libDir, { mirror: false, package: true });
        }
    };
}

// ============================================================================
// Module Export
// ============================================================================

module.exports = {
    name: 'parse',
    description: 'Parse Node Java Library',

    actions: [
        // Internal actions
        { name: 'parse:sync-source', action: makeSyncSourceAction },
        { name: 'parse:build-jar', action: makeBuildJarAction },
        { name: 'parse:sync', action: makeCopyOutputsAction },
        { name: 'parse:test-jar', action: makeTestJarAction },

        // Submodule actions (called by nodes:build / nodes:clean)
        { name: 'parse:submodule-build', action: () => ({
            steps: [
                // Installs rocketride-core, which this module depends on
                'java:submodule-build',
                'parse:sync-source',
                'parse:build-jar',
                'parse:sync'
            ]
        })},
        { name: 'parse:submodule-test', action: () => ({
            steps: [
                'parse:submodule-build',
                'parse:test-jar'
            ]
        })},
        { name: 'parse:submodule-clean', action: () => ({
            run: async (ctx, task) => {
                await removeDirs([
                    BUILD_DIR,
                    path.join(PACKAGE_DIR, 'lib', 'parse', 'target')
                ]);
                await removeFile(path.join(PACKAGE_DIR, 'lib', 'parse', 'pom.xml'));
                task.output = 'Cleaned parse';
            }
        })}
    ]
};
