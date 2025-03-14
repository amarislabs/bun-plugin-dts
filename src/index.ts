import { promises as fs } from "node:fs";
import path from "node:path";
import { CryptoHasher, type PluginBuilder } from "bun";
import commonPathPrefix from "common-path-prefix";
import { type EntryPointConfig, generateDtsBundle } from "dts-bundle-generator";
import { getTsconfig } from "get-tsconfig";

interface CacheEntry {
    hash: string;
    mtime: number;
    content: string;
    lastUsed: number;
}

interface CacheFile {
    version: string;
    entries: Record<string, CacheEntry>;
}

interface PathCacheEntry {
    path: string;
    hash: string;
    mtime: number;
}

interface ProcessedEntries {
    entriesToProcess: EntryPointConfig[];
    entryFiles: PathCacheEntry[];
}

type Options = {
    cacheDir?: string | boolean;
    useContentHashing?: boolean;
    cacheVersion?: string;
    parallelLimit?: number;
    maxCacheEntries?: number;
};

const DEFAULT_CACHE_DIR = ".cache";
const CACHE_VERSION = "1.0.0";
const CACHE_FILENAME = "dts-cache.json";
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

const dts = (options?: Options): import("bun").BunPlugin => {
    let cache: CacheFile = {
        version: options?.cacheVersion ?? CACHE_VERSION,
        entries: {},
    };

    let cacheLoaded = false;
    let cacheModified = false;
    let cacheDisabled = options?.cacheDir === undefined || options?.cacheDir === false;
    const maxCacheEntries = options?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;

    return {
        name: "@amarislabs/bun-plugin-dts",
        async setup(build: PluginBuilder): Promise<void> {
            const { useContentHashing = true, parallelLimit = 10 } = options || {};

            let cacheDirPath: string = DEFAULT_CACHE_DIR;
            if (options?.cacheDir === true) {
                cacheDisabled = false;
            } else if (typeof options?.cacheDir === "string") {
                cacheDirPath = options.cacheDir;
                cacheDisabled = false;
            }

            const outDir: string = build.config.outdir || "./dist";
            const cacheFilePath: string = path.join(cacheDirPath, CACHE_FILENAME);

            await fs.mkdir(outDir, { recursive: true }).catch((): undefined => undefined);
            await loadCache(cacheDirPath, cacheFilePath);

            const entrypoints: string[] = [...build.config.entrypoints].sort();
            if (entrypoints.length === 0) return;

            const { entriesToProcess, entryFiles } = await prepareEntries(entrypoints, useContentHashing);
            if (entriesToProcess.length === 0) return;

            const results: Map<string, string> = generateDtsFiles(entriesToProcess, getTsconfig()?.path, parallelLimit);

            await writeOutputFiles(entrypoints, entryFiles, results, outDir);
            await writeCache(cacheFilePath);
        },
    };

    async function loadCache(cacheDir: string, cacheFilePath: string): Promise<void> {
        if (cacheLoaded || cacheDisabled) return;

        try {
            if (cacheDir) {
                await fs.mkdir(cacheDir, { recursive: true });

                const compressedData = await Bun.file(cacheFilePath).arrayBuffer();
                if (compressedData.byteLength === 0) {
                    cache = { version: CACHE_VERSION, entries: {} };
                    return;
                }

                const decompressedData = Bun.gunzipSync(new Uint8Array(compressedData));
                const cacheContent: string = new TextDecoder().decode(decompressedData);
                const loadedCache = JSON.parse(cacheContent) as CacheFile;

                if (loadedCache.version === CACHE_VERSION) cache = loadedCache;
            } else {
                cacheDisabled = true;
            }
        } catch {
            cache = { version: CACHE_VERSION, entries: {} };
        }

        cacheLoaded = true;
    }

    async function prepareEntries(entrypoints: string[], useContentHashing: boolean): Promise<ProcessedEntries> {
        cacheModified = invalidateStaleEntries(cacheDisabled, cacheLoaded, cache, entrypoints, cacheModified);

        const entryFiles: PathCacheEntry[] = await Promise.all(
            entrypoints.map(async (entry: string): Promise<PathCacheEntry> => {
                try {
                    let hash = "";
                    const stats = await fs.stat(entry);

                    if (useContentHashing && !cacheDisabled) {
                        const content: string = await Bun.file(entry).text();
                        hash = new CryptoHasher("blake2b256").update(content).digest("hex");
                    }
                    return { path: entry, mtime: stats.mtimeMs, hash };
                } catch {
                    return { path: entry, mtime: 0, hash: "" };
                }
            })
        );

        const entriesToProcess: EntryPointConfig[] = [];

        for (const [index, file] of entryFiles.entries()) {
            const entry: string = entrypoints[index];
            if (cacheDisabled || shouldGenerateEntry(entry, file, useContentHashing)) {
                entriesToProcess.push({ filePath: entry });
            }
        }

        return { entriesToProcess, entryFiles };
    }

    function invalidateStaleEntries(
        cacheDisabled: boolean,
        cacheLoaded: boolean,
        cache: CacheFile,
        entrypoints: string[],
        cacheModified: boolean
    ): boolean {
        let _cacheModified: boolean = cacheModified;

        if (!cacheDisabled && cacheLoaded && Object.keys(cache.entries).length > 0) {
            const existingEntries = new Set(entrypoints);
            const staleEntries: string[] = Object.keys(cache.entries).filter(
                (entry: string): boolean => !existingEntries.has(entry)
            );

            if (staleEntries.length > 0) {
                for (const staleEntry of staleEntries) {
                    delete cache.entries[staleEntry];
                }
                _cacheModified = true;
            }
        }
        return _cacheModified;
    }

    function shouldGenerateEntry(
        entry: string,
        fileStats: Omit<CacheEntry, "content" | "lastUsed">,
        useContentHashing: boolean
    ): boolean {
        if (cacheDisabled) return true;

        const cachedEntry: CacheEntry = cache.entries[entry];
        if (!cachedEntry) return true;

        cachedEntry.lastUsed = Date.now();
        cacheModified = true;

        return useContentHashing ? cachedEntry.hash !== fileStats.hash : cachedEntry.mtime !== fileStats.mtime;
    }

    function pruneCache() {
        const entries = Object.entries(cache.entries);
        if (entries.length <= maxCacheEntries) return;

        entries.sort(([, a], [, b]) => (a.lastUsed || 0) - (b.lastUsed || 0));

        const entriesToRemove = entries.length - maxCacheEntries;
        for (let i = 0; i < entriesToRemove; i++) {
            delete cache.entries[entries[i][0]];
        }

        cacheModified = true;
    }

    function generateDtsFiles(
        entries: EntryPointConfig[],
        tsconfigPath: string | undefined,
        parallelLimit: number
    ): Map<string, string> {
        const results = new Map<string, string>();

        for (let i = 0; i < entries.length; i += parallelLimit) {
            const batch: EntryPointConfig[] = entries.slice(i, i + parallelLimit);
            const batchResults: string[] = generateDtsBundle(batch, {
                preferredConfigPath: tsconfigPath,
            });

            for (let j = 0; j < batch.length; j++) {
                results.set(batch[j].filePath, batchResults[j]);
            }
        }

        return results;
    }

    async function writeOutputFiles(
        entrypoints: string[],
        fileStats: Array<{ path: string; hash: string; mtime: number }>,
        results: Map<string, string>,
        outDir: string
    ): Promise<void> {
        const commonPrefix: string = computeCommonPathPrefix(entrypoints);

        await Promise.all(
            entrypoints.map(async (entry: string, index: number): Promise<void> => {
                const relativePath: string = path.relative(commonPrefix, entry);

                const dtsFile: string = relativePath.replace(/\.[jtm]s$/, ".d.ts");
                const outFile: string = path.join(outDir, dtsFile);
                const content: string = results.get(entry) || "";

                if (!cacheDisabled) {
                    cache.entries[entry] = {
                        hash: fileStats[index].hash,
                        mtime: fileStats[index].mtime,
                        content,
                        lastUsed: Date.now(),
                    };
                    cacheModified = true;
                }

                await fs.mkdir(path.dirname(outFile), { recursive: true }).catch((): undefined => undefined);

                await Bun.write(outFile, content);
            })
        );

        if (!cacheDisabled) {
            pruneCache();
        }
    }

    async function writeCache(cacheFilePath: string): Promise<void> {
        if (!cacheModified || cacheDisabled) return;

        try {
            const tempFilePath = `${cacheFilePath}.tmp`;
            const cacheJson = JSON.stringify(cache, null, 2);
            const compressedData = Bun.gzipSync(Buffer.from(cacheJson));
            await Bun.write(tempFilePath, compressedData);
            await fs.rename(tempFilePath, cacheFilePath);
        } catch (error) {
            console.error("@amarislabs/bun-plugin-dts: Failed to write cache file", error);
        }
    }

    function computeCommonPathPrefix(entrypoints: string[]): string {
        let prefix: string = commonPathPrefix(entrypoints);
        if (!prefix || prefix === process.cwd()) {
            prefix = path.dirname(entrypoints[0]);
        }
        return prefix;
    }
};

export default dts;
