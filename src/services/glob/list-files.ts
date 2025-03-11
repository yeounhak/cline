import { fdir, PathsOutput } from "fdir"
import os from "os"
import * as path from "path"
import { arePathsEqual } from "../../utils/path"
import ignore from "ignore"
import * as fs from "fs"

// Default directories to ignore
const DEFAULT_IGNORE_DIRS = [
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"target/dependency",
	"build/dependencies",
	"dist",
	"out",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"pkg",
	"Pods",
	".*", // Hidden directories
]

// Cache for directory checks to avoid repeated fs.statSync calls
const directoryCache = new Map<string, boolean>()

interface CrawlOptions {
	limit: number
	timeout: number
	ignorePatterns: string[]
	recursive: boolean
}

class FileScanner {
	private ig: ReturnType<typeof ignore>
	private results: Set<string>
	private abortController: AbortController

	constructor(ignorePatterns: string[]) {
		this.ig = ignore().add(ignorePatterns)
		this.results = new Set()
		this.abortController = new AbortController()
	}

	private isDirectory(filePath: string): boolean {
		if (directoryCache.has(filePath)) {
			return directoryCache.get(filePath)!
		}
		try {
			const isDir = fs.statSync(filePath).isDirectory()
			directoryCache.set(filePath, isDir)
			return isDir
		} catch (error) {
			directoryCache.set(filePath, false)
			return false
		}
	}

	private shouldIncludeFile(filePath: string, options: CrawlOptions): boolean {
		if (this.results.size >= options.limit) {
			return false
		}

		const relativePath = path.relative(path.dirname(filePath), filePath)
		if (options.recursive && this.ig.ignores(relativePath)) {
			return false
		}

		return true
	}

	private processFile(filePath: string, options: CrawlOptions): boolean {
		if (!this.shouldIncludeFile(filePath, options)) {
			return false
		}

		const normalizedPath = filePath.replace(/\\/g, "/")
		const isDir = this.isDirectory(filePath)
		const finalPath = isDir ? normalizedPath + "/" : normalizedPath

		this.results.add(finalPath)
		return true
	}

	private async crawlChunk(paths: string[], options: CrawlOptions): Promise<void> {
		const promises = paths.map(async (filePath) => {
			if (this.abortController.signal.aborted) {
				return
			}

			const processed = this.processFile(filePath, options)
			if (!processed) {
				return
			}

			if (options.recursive && this.isDirectory(filePath)) {
				const builder = new fdir().withFullPaths().withMaxDepth(1).crawl(filePath)

				try {
					const subFiles = await builder.withPromise()
					await this.crawlChunk(subFiles, options)
				} catch (error) {
					console.warn(`Error scanning directory ${filePath}:`, error)
				}
			}
		})

		await Promise.all(promises)
	}

	public async scan(dirPath: string, options: CrawlOptions): Promise<[string[], boolean]> {
		try {
			const initialBuilder = new fdir().withFullPaths().withMaxDepth(1).crawl(dirPath)

			const files = await initialBuilder.withPromise()

			const timeoutPromise = new Promise<void>((_, reject) => {
				setTimeout(() => {
					this.abortController.abort()
					reject(new Error("File scanning timeout"))
				}, options.timeout)
			})

			await Promise.race([this.crawlChunk(files, options), timeoutPromise])
		} catch (error) {
			if (error instanceof Error && error.message !== "File scanning timeout") {
				console.warn("Error during file scanning:", error)
			}
		}

		const results = Array.from(this.results)
		return [results, results.length >= options.limit]
	}
}

export async function listFiles(dirPath: string, recursive: boolean, limit: number): Promise<[string[], boolean]> {
	const absolutePath = path.resolve(dirPath)

	// Do not allow listing files in root or home directory, which cline tends to want to do when the user's prompt is vague.
	const root = process.platform === "win32" ? path.parse(absolutePath).root : "/"
	const isRoot = arePathsEqual(absolutePath, root)
	if (isRoot) {
		return [[root], false]
	}
	const homeDir = os.homedir()
	const isHomeDir = arePathsEqual(absolutePath, homeDir)
	if (isHomeDir) {
		return [[homeDir], false]
	}

	// Initialize ignore patterns
	const ignorePatterns = DEFAULT_IGNORE_DIRS.map((dir) => `**/${dir}/**`)

	// Add .gitignore patterns if recursive mode and .gitignore exists
	if (recursive) {
		const gitignorePath = path.join(dirPath, ".gitignore")
		try {
			if (fs.existsSync(gitignorePath)) {
				const gitignoreContent = fs.readFileSync(gitignorePath, "utf8")
				ignorePatterns.push(...gitignoreContent.split("\n"))
			}
		} catch (error) {
			console.warn("Error reading .gitignore:", error)
		}
	}

	const scanner = new FileScanner(ignorePatterns)
	return scanner.scan(absolutePath, {
		limit,
		timeout: 10_000,
		ignorePatterns,
		recursive,
	})
}
