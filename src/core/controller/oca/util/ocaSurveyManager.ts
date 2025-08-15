import express, { Express } from "express"
import { Server } from "http"
import { DEFAULT_OCA_BASE_URL, DEFAULT_SURVEY_PORT } from "./constants"
import { OcaTokenManager } from "./ocaTokenManager"
import { name, version } from "../../../../../package.json"
import * as vscode from "vscode"
import { Logger } from "@/services/logging/Logger"
import { generateOpcRequestId } from "./utils"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import fetch from "node-fetch"
import { execSync } from "child_process"
import { openInBrowser } from "../../web/openInBrowser"
import * as net from "net"
import osmod from "os"
import { StringRequest } from "@/shared/proto/index.cline"
const SUBMIT_SURVEY_EVENT_PATH = "submitSurveyEvent"
// ---------- CROSS PLATFORM KILL UTILITIES ----------
function isWindows() {
	return osmod.platform() === "win32"
}
function isPortInUseSync(port: number): boolean {
	try {
		if (isWindows()) {
			// Windows: netstat -ano | findstr :<port>
			const out = execSync(`netstat -ano | findstr :${port}`, { stdio: "pipe" }).toString()
			return out.trim().length > 0
		} else {
			// POSIX: lsof -t -i :<port>
			const out = execSync(`lsof -t -i :${port}`, { stdio: "pipe" }).toString()
			return out.trim().length > 0
		}
	} catch {
		return false
	}
}
function killProcessOnPortSync(port: number): number[] {
	const killed: number[] = []
	try {
		if (isWindows()) {
			// netstat -ano | findstr :<port>
			const out = execSync(`netstat -ano | findstr :${port}`, { stdio: "pipe" }).toString()
			// e.g.: TCP    0.0.0.0:3000  ...  LISTENING  12345
			const lines = out.split("\n")
			for (const line of lines) {
				const match = line.match(/LISTENING\s+(\d+)/) || line.match(/ESTABLISHED\s+(\d+)/)
				if (match) {
					const pid = parseInt(match[1], 10)
					if (pid === process.pid) {
						Logger.log(`Skip killing own PID ${pid} on port ${port}`)
						continue
					}
					try {
						execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" })
						Logger.log(`Killed process PID ${pid} on port ${port}`)
						killed.push(pid)
					} catch (killErr) {
						Logger.warn?.(`Failed to kill PID ${pid} (Windows): ${killErr}`)
					}
				}
			}
		} else {
			// POSIX/Mac: lsof -t -i :port
			const out = execSync(`lsof -t -i :${port}`, { stdio: "pipe" }).toString()
			const pids = [
				...new Set(
					out
						.trim()
						.split("\n")
						.map((x) => parseInt(x, 10))
						.filter(Boolean),
				),
			]
			for (const pid of pids) {
				if (pid === process.pid) {
					Logger.log(`Skip killing own PID ${pid} on port ${port}`)
					continue
				}
				try {
					process.kill(pid, "SIGKILL")
					Logger.log(`Killed process PID ${pid} on port ${port}`)
					killed.push(pid)
				} catch (killErr) {
					Logger.warn?.(`Failed to kill PID ${pid} (Unix): ${killErr}`)
				}
			}
		}
	} catch {}
	return killed
}
// ----------- SERVER IMPLEMENTATION ------------
export class OcaSurveyManager {
	private static server?: Server
	public static serverPort: number | undefined
	private static surveyHtmlPath?: string
	public static createSurveyHtml(args: {
		surveyHtml: string
		surveyId: string
		modelId: string
		client: string
		clientVersion: string
		port: number
	}): string | undefined {
		if (this.surveyHtmlPath && fs.existsSync(this.surveyHtmlPath)) {
			try {
				fs.unlinkSync(this.surveyHtmlPath)
			} catch (err) {
				Logger.warn?.(`Error removing previous survey HTML file: ${err instanceof Error ? err.message : String(err)}`)
			}
			this.surveyHtmlPath = undefined
		}
		let html = args.surveyHtml
		html = html
			.replace(/MODEL_PLACEHOLDER/g, args.modelId)
			.replace(/SURVEY_ID_PLACEHOLDER/g, args.surveyId)
			.replace(/API_ENDPOINT_PLACEHOLDER/g, `http://localhost:${args.port}/${SUBMIT_SURVEY_EVENT_PATH}`)
			.replace(/CLIENT_PLACEHOLDER/g, args.client)
			.replace(/CLIENT_VERSION_PLACEHOLDER/g, args.clientVersion)
		const tmpDir = os.tmpdir()
		const fileName = `oca_survey_${Date.now()}_${Math.random().toString(36).slice(2)}.html`
		const filePath = path.join(tmpDir, fileName)
		fs.writeFileSync(filePath, html, "utf8")
		this.surveyHtmlPath = filePath
		Logger.log(`Survey HTML saved to: ${filePath}`)
		return filePath
	}
	/** Returns the first available port (not in use) within the range, trying to kill if needed. */
	static async findOpenPort(startPort: number, maxAttempts: number): Promise<number> {
		let port = startPort
		for (let i = 0; i < maxAttempts; i++, port++) {
			if (!isPortInUseSync(port)) {
				// Try to open and close a server quickly to be sure
				const tester = net.createServer()
				const opened = await new Promise<boolean>((res) => {
					tester.once("error", () => res(false))
					tester.listen(port, "127.0.0.1", () => res(true))
				})
				if (opened) {
					tester.close()
					return port
				}
			} else {
				Logger.warn?.(`Port ${port} is already in use. Waiting briefly and trying next port...`)
				// Try to close running server (if we own it)
				if (this.serverPort === port && this.server) {
					try {
						await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())))
					} catch (e) {
						Logger.warn?.(`Error closing Node server on port ${port}: ${e instanceof Error ? e.message : String(e)}`)
					}
					this.server = undefined
				}
				// Instead of killing, wait briefly and try next port
				await new Promise((res) => setTimeout(res, 300))
			}
		}
		throw new Error(`Could not find available port in range starting at ${startPort}`)
	}
	/**
	 * Starts the local server and exposes /survey and /actions/fillSurvey, with CORS allowing all origins/headers/methods.
	 * Always returns an unused port.
	 */
	public static async startServer(
		port: number = DEFAULT_SURVEY_PORT,
		redirectBaseUrl: string = DEFAULT_OCA_BASE_URL,
		maxAttempts: number = 20,
	): Promise<number> {
		if (this.server) {
			Logger.log(`Server already running on port ${this.serverPort}, closing before retrying`)
			try {
				await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())))
			} catch (e) {
				Logger.warn?.(`Error shutting down previous server: ${e instanceof Error ? e.message : String(e)}`)
			}
			this.server = undefined
			this.serverPort = undefined
		}
		// Find an open/killable port
		const portInUse = await this.findOpenPort(port, maxAttempts)
		const app = express()
		// CORS Middleware: allow all
		app.use((req, res, next): void => {
			res.setHeader("Access-Control-Allow-Origin", "*")
			res.setHeader(
				"Access-Control-Allow-Headers",
				"Origin, X-Requested-With, Content-Type, Accept, Authorization, client, client-version, client-ide, client-ide-version, X-Custom-Header, opc-request-id",
			)
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			if (req.method === "OPTIONS") {
				res.sendStatus(200)
				return
			}
			next()
		})
		app.use(express.json({ limit: "5mb" }))
		app.get("/survey", (req, res) => {
			Logger.log(`Received GET /survey request`)
			if (this.surveyHtmlPath && fs.existsSync(this.surveyHtmlPath)) {
				Logger.log(`Serving survey HTML file: ${this.surveyHtmlPath}`)
				res.setHeader("Content-Type", "text/html; charset=utf-8")
				res.sendFile(this.surveyHtmlPath, (err) => {
					if (err) {
						Logger.warn?.(`Error sending survey file: ${err.message}`)
						res.status(500).send("Error serving survey HTML")
					} else {
						Logger.log(`Survey HTML file sent successfully`)
					}
				})
			} else {
				Logger.warn?.(`Survey HTML file not found: ${this.surveyHtmlPath}`)
				res.status(404).send("Survey HTML not found")
			}
		})
		app.get("/surveyOpenInBrowser", (req, res) => {
			const url = `http://localhost:${portInUse}/survey`
			Logger.log(`Opening survey in browser at: ${url}`)
			openInBrowser(null, StringRequest.create({ value: url }))
				.then(() => {
					res.send(`Opened survey in browser at ${url}`)
				})
				.catch((err) => {
					Logger.warn?.(`Failed to open browser: ${err.message}`)
					res.status(500).send("Failed to open browser")
				})
		})
		// Utility to wrap async Express handlers
		const asyncHandler = (fn: Function) => (req: any, res: any, next: any) => {
			Promise.resolve(fn(req, res, next)).catch(next)
		}
		app.post(
			`/${SUBMIT_SURVEY_EVENT_PATH}`,
			asyncHandler(
				async (
					req: { body: any },
					res: {
						status: (arg0: number) => {
							(): any
							new (): any
							json: { (arg0: { error: string; status?: number; details?: any }): void; new (): any }
						}
						setHeader: (arg0: string, arg1: string) => void
						end: (arg0: Buffer) => void
					},
				) => {
					try {
						const token = await OcaTokenManager.getToken()
						let opcRequestId = ""
						const headers: any = {
							"Content-Type": "application/json",
							"X-Custom-Header": "HeaderValue",
							"X-Requested-By": "OcaSurveyManager",
							client: "Cline",
							"client-version": `${name}-${version}`,
							"client-ide": vscode.env.appName,
							"client-ide-version": vscode.version,
						}
						if (token) {
							headers["Authorization"] = `Bearer ${token.access_token}`
							opcRequestId = await generateOpcRequestId("surveyTask", token.access_token!)
							headers["opc-request-id"] = opcRequestId
						}
						const url = `${redirectBaseUrl.replace(/\/+$/, "")}/${SUBMIT_SURVEY_EVENT_PATH.replace(/^\/+/, "")}`
						Logger.log(`[survey] Forwarding to: ${url} and customer opc-request-id: ${opcRequestId}`)
						const backendResp = await fetch(url, {
							method: "POST",
							headers: headers,
							body: JSON.stringify(req.body),
						})
						if (!backendResp.ok) {
							let errorBody: any
							let errorText: string = ""
							let contentType = backendResp.headers.get("content-type") || ""
							try {
								if (contentType.includes("application/json")) {
									errorBody = await backendResp.json()
								} else {
									errorText = await backendResp.text()
								}
							} catch (parseErr) {
								errorText = "Failed to parse error response body."
							}
							Logger.warn?.(
								`[survey] Backend responded with status ${backendResp.status}: ` +
									(errorBody ? JSON.stringify(errorBody) : errorText),
							)
							res.status(backendResp.status).json({
								error: "Backend service error",
								status: backendResp.status,
								details: errorBody || errorText,
							})
							return
						}
						// On success, pipe the response through as before
						res.status(backendResp.status)
						backendResp.headers.forEach((value, key) => {
							if (key.toLowerCase() !== "content-length") {
								res.setHeader(key, value)
							}
						})
						const buffer = await backendResp.buffer()
						res.end(buffer)
					} catch (err) {
						Logger.warn?.(
							`Error forwarding /${SUBMIT_SURVEY_EVENT_PATH}: ` +
								(err instanceof Error ? err.message : String(err)),
						)
						res.status(500).json({
							error: "Failed to forward survey: " + (err instanceof Error ? err.message : String(err)),
						})
					}
				},
			),
		)
		try {
			await new Promise<void>((resolve, reject) => {
				const server = app.listen(portInUse, "127.0.0.1", () => resolve())
				server.once("error", reject)
				this.server = server
			})
			this.serverPort = portInUse
			Logger.log(`OcaSurveyManager server started on port ${portInUse}`)
			return portInUse
		} catch (err: any) {
			Logger.warn?.(`Could not start server on port ${portInUse}: ${err instanceof Error ? err.message : String(err)}`)
			throw err
		}
	}
	/** Destructor-style: stops the server and cleans up the html file and kills process on port if possible. */
	public static async stopServer() {
		if (this.server) {
			try {
				await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())))
			} catch (e) {
				Logger.warn?.(`Error shutting down server: ${e instanceof Error ? e.message : String(e)}`)
			}
			// Removed: killProcessOnPortSync
			this.server = undefined
			this.serverPort = undefined
			if (this.surveyHtmlPath && fs.existsSync(this.surveyHtmlPath)) {
				try {
					fs.unlinkSync(this.surveyHtmlPath)
				} catch (err) {
					Logger.warn?.(`Error removing survey HTML file: ${err instanceof Error ? err.message : String(err)}`)
				}
				this.surveyHtmlPath = undefined
			}
			Logger.log("OcaSurveyManager server stopped")
		}
	}
}
