import { BaseUrlField } from "../common/BaseUrlField"
import OcaModelPicker from "../OcaModelPicker"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useMount } from "react-use"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { Mode } from "@shared/storage/types"
import {
	VSC_BUTTON_BACKGROUND,
	VSC_BUTTON_FOREGROUND,
	VSC_DESCRIPTION_FOREGROUND,
	VSC_INPUT_BACKGROUND,
	VSC_INPUT_BORDER,
} from "@/utils/vscStyles"

/**
 * Props for the OcaProvider component
 */
interface OcaProviderProps {
	isPopup?: boolean
	currentMode: Mode
}

import React, { useMemo } from "react"
import { GenerateSurveyHtmlRequest, GenerateSurveyHtmlResponse, OcaModelInfo } from "@shared/proto/index.cline"
import { normalizeApiConfiguration } from "../utils/providerUtils"

function isTokenValid(accessToken?: string, expiresAt?: number, bufferSec = 300) {
	if (!accessToken || !expiresAt) return false
	return expiresAt * 1000 > Date.now() + bufferSec * 1000
}

function InfoCard({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<div
			className={`flex items-start gap-3 rounded-xl px-5 py-4 border shadow-sm min-w-[40%] max-w-[90%] w-full box-border 
                 bg-[var(${VSC_INPUT_BACKGROUND})] border-[var(${VSC_INPUT_BORDER})]`}>
			<div className="min-w-[22px] h-[22px] flex items-center justify-center shrink-0 mt-px">{icon}</div>
			<div className="flex-1">{children}</div>
		</div>
	)
}

type OcaSurveyFormProps = {
	surveyContent?: string
	surveyId: string
	modelId: string
	modelVersion: string
}
const OcaSurveyForm: React.FC<OcaSurveyFormProps> = (props) => {
	const { ocaStartSurveyProxy, ocaGenerateSurveyHtml, ocaStopSurveyProxy } = useExtensionState()
	const [surveyServerPort, setSurveyServerPort] = React.useState<number | undefined>(undefined)
	const [surveyUrl, setSurveyUrl] = React.useState<string | undefined>(undefined)
	const [starting, setStarting] = React.useState(true)
	const [error, setError] = React.useState<string | undefined>(undefined)
	React.useEffect(() => {
		let isCancelled = false
		setStarting(true)
		setError(undefined)
		setSurveyUrl(undefined)
		let localPort: number | undefined
		// Step 1: Start server and get port
		ocaStartSurveyProxy()
			.then((response: { port: number | undefined }) => {
				if (isCancelled) return
				localPort = response.port
				setSurveyServerPort(localPort)
				// Step 2: Generate survey HTML at given port
				const request = GenerateSurveyHtmlRequest.create({
					surveyHtml: props.surveyContent || "",
					surveyId: props.surveyId,
					modelId: props.modelId,
					client: "",
					clientVersion: "",
				})
				return ocaGenerateSurveyHtml(request)
			})
			.then((htmlResp?: GenerateSurveyHtmlResponse) => {
				if (isCancelled) return
				if (!htmlResp) throw new Error("No HTML response returned")
				setSurveyUrl(htmlResp.url || `http://localhost:${localPort}/survey`)
			})
			.catch((err: Error) => {
				if (!isCancelled) {
					setSurveyServerPort(undefined)
					setSurveyUrl(undefined)
					setError(typeof err === "object" && err && "message" in err ? (err as any).message : String(err))
				}
				console.error("Error in survey start/generate:", err)
			})
			.finally(() => {
				if (!isCancelled) setStarting(false)
			})
		return () => {
			isCancelled = true
			ocaStopSurveyProxy().catch((err: Error) => {
				console.error("Error stopping survey proxy:", err)
			})
		}
		// Only rerun effect on actual prop changes, not context changes
	}, [props.surveyContent, props.modelId, props.surveyId, props.modelVersion])
	if (error) {
		return (
			<div style={{ color: "var(--vscode-errorForeground,#f13d3d)", padding: 32, textAlign: "center", fontSize: 15 }}>
				Error loading survey: {error}
			</div>
		)
	}
	if (starting || !surveyUrl) {
		return <div style={{ padding: 32, textAlign: "center" }}>Loading survey…</div>
	}
	return (
		<iframe
			src={surveyUrl}
			title="OCA Survey"
			width="100%"
			height="100%"
			style={{
				wordBreak: "break-word",
				background: "var(--vscode-editorWidget-foreground, #252526)",
				color: "var(--vscode-editorWidget-background, #cccccc)",
			}}
			allow="clipboard-write"
			// Optionally, you could pass data- attributes if the iframe is same-origin and picks them up
		/>
	)
}

/**
 * The Oca provider configuration component
 */
export const OcaProvider = ({ isPopup, currentMode }: OcaProviderProps) => {
	const { apiConfiguration, ocaRefreshToken, ocaLogin, ocaLogout } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()
	const [showSurvey, setShowSurvey] = React.useState(false)
	const { selectedModelId, selectedModelInfo } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, currentMode)
	}, [apiConfiguration])

	useMount(() => {
		if (apiConfiguration?.ocaAccessToken !== "logout") ocaRefreshToken()
	})

	const handleSurveyClick = () => {
		setShowSurvey(true)
	}
	const closeSurvey = () => {
		setShowSurvey(false)
	}

	return (
		<div>
			{!isTokenValid(apiConfiguration?.ocaAccessToken, apiConfiguration?.ocaAccessTokenExpiresAt) ? (
				<div>
					<VSCodeButton
						style={{
							fontSize: 14,
							borderRadius: 22,
							fontWeight: 500,
							background: "var(--vscode-button-background, #0078d4)",
							color: "var(--vscode-button-foreground, #fff)",
							minWidth: 0,
							margin: "12px 0",
						}}
						onClick={ocaLogin}>
						Sign In to Oracle Code Assist
					</VSCodeButton>
				</div>
			) : (
				<div>
					<div
						className={`flex flex-col gap-1 font-semibold text-[13px] my-[12px] [color:var(${VSC_DESCRIPTION_FOREGROUND})]`}>
						<span>Logged in as</span>
						<span className="font-semibold opacity-95">{apiConfiguration?.ocaAccessTokenSub ?? "Unknown User"}</span>
					</div>
					<BaseUrlField
						initialValue={apiConfiguration?.ocaBaseUrl || ""}
						defaultValue={undefined}
						onChange={(value) => handleFieldChange("ocaBaseUrl", value)}
						label="Use Custom Base URL (optional)"
					/>
					<OcaModelPicker isPopup={isPopup} currentMode={currentMode} />
					<VSCodeButton
						style={{
							fontSize: 14,
							borderRadius: 22,
							fontWeight: 500,
							background: `var(${VSC_BUTTON_BACKGROUND}, #0078d4)`,
							color: `var(${VSC_BUTTON_FOREGROUND}, #fff)`,
							minWidth: 0,
							margin: "12px 0",
						}}
						onClick={ocaLogout}>
						Log out
					</VSCodeButton>
					{/* INFO/GUIDE CARD */}
					<InfoCard
						icon={
							<svg width="20" height="20" viewBox="0 0 31 31" fill="none" aria-hidden role="img">
								<path
									d="M0.0805664 1.62516C0.0805664 0.773724 0.770794 0.0834961 1.62223 0.0834961H10.8738C12.7148 0.0834961 14.3675 0.890779 15.4972 2.17059C16.627 0.890779 18.2797 0.0834961 20.1207 0.0834961H29.3722C30.2237 0.0834961 30.9139 0.773724 30.9139 1.62516V24.7486C30.9139 25.6001 30.2237 26.2903 29.3722 26.2903H20.1222C18.4176 26.2903 17.0389 27.669 17.0389 29.3736C17.0389 30.2251 16.3487 30.9153 15.4972 30.9153C14.6458 30.9153 13.9556 30.2251 13.9556 29.3736C13.9556 27.669 12.5769 26.2903 10.8722 26.2903H1.62223C0.770794 26.2903 0.0805664 25.6001 0.0805664 24.7486V1.62516ZM13.9556 24.0311V6.24862C13.9556 4.54706 12.5753 3.16683 10.8738 3.16683H3.1639V23.207H10.8722C11.9957 23.207 13.0487 23.5069 13.9556 24.0311ZM17.0389 24.0311C17.9458 23.5069 18.9988 23.207 20.1222 23.207H27.8306V3.16683H20.1207C18.4191 3.16683 17.0389 4.54706 17.0389 6.24862V24.0311Z"
									fill="none"
									stroke="white"
									strokeWidth="1.25"
								/>
							</svg>
						}>
						<div className={`text-[14px] leading-[1.65] [color:var(${VSC_DESCRIPTION_FOREGROUND})]`}>
							For internal Oracle Employees, <br />
							please see the{" "}
							<VSCodeLink
								href="https://confluence.oraclecorp.com/confluence/display/AICODE/Oracle+Code+Assist+via+Cline"
								style={{ color: "var(--vscode-textLink-foreground, #3794ff)", fontSize: 14, fontWeight: 500 }}>
								Quickstart Guide
							</VSCodeLink>
							.<br />
							For external customers, contact your IT admin to provision Oracle Code Assist as a provider.
						</div>
					</InfoCard>
					{/* FEEDBACK CARD */}
					<InfoCard
						icon={
							<svg width="20" height="20" viewBox="0 0 36 35" fill="none" aria-hidden role="img">
								<g clipPath="url(#clip0)">
									<path
										d="M20 13.5991C20 14.672 19.1046 15.5418 18 15.5418C16.8954 15.5418 16 14.672 16 13.5991C16 12.5261 16.8954 11.6563 18 11.6563C19.1046 11.6563 20 12.5261 20 13.5991Z"
										fill="none"
										stroke="white"
										strokeWidth="1.25"
									/>
									<path
										d="M10 15.5418C11.1046 15.5418 12 14.672 12 13.5991C12 12.5261 11.1046 11.6563 10 11.6563C8.89543 11.6563 8 12.5261 8 13.5991C8 14.672 8.89543 15.5418 10 15.5418Z"
										fill="none"
										stroke="white"
										strokeWidth="1.25"
									/>
									<path
										d="M28 13.5991C28 14.672 27.1046 15.5418 26 15.5418C24.8954 15.5418 24 14.672 24 13.5991C24 12.5261 24.8954 11.6563 26 11.6563C27.1046 11.6563 28 12.5261 28 13.5991Z"
										fill="none"
										stroke="white"
										strokeWidth="1.25"
									/>
									<path
										fillRule="evenodd"
										clipRule="evenodd"
										d="M0 0V25.2554H10V34.4L19.4142 25.2554H36V0H0ZM2 23.3127V1.94272H34V23.3127H18.5858L12 29.7099V23.3127H2Z"
										fill="none"
										stroke="white"
										strokeWidth="1.25"
									/>
								</g>
								<defs>
									<clipPath id="clip0">
										<rect width="36" height="35" fill="white" />
									</clipPath>
								</defs>
							</svg>
						}>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								alignItems: "center", // center title and button
								width: "100%",
							}}>
							<div
								style={{
									fontSize: 14,
									color: "var(--vscode-descriptionForeground)",
									fontWeight: 600,
									marginBottom: 18,
									marginTop: 2,
								}}>
								Help us improve!
							</div>
							<VSCodeButton
								style={{
									fontSize: 14,
									borderRadius: 22,
									fontWeight: 500,
									background: "var(--vscode-button-background, #0078d4)",
									color: "var(--vscode-button-foreground, #fff)",
									minWidth: 0,
									margin: 0,
								}}
								onClick={handleSurveyClick}>
								Provide feedback
							</VSCodeButton>
						</div>
					</InfoCard>
				</div>
			)}
			{showSurvey && (
				<div
					style={{
						position: "fixed",
						zIndex: 2000,
						left: 0,
						top: 10,
						width: "100%",
						height: "100%",
						background: "rgba(32,32,32,0.66)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					}}
					onClick={closeSurvey}>
					<div
						style={{
							background: "#222",
							padding: 0,
							borderRadius: 8,
							minWidth: 350,
							minHeight: 200,
							width: "100%",
							height: "100%",
							overflow: "auto",
							color: "var(--vscode-editorWidget-foreground, #cccccc)",
							fontSize: 13,
							position: "relative",
						}}
						onClick={(e) => e.stopPropagation()}>
						<button
							onClick={closeSurvey}
							style={{
								position: "absolute",
								border: "none",
								right: 16,
								top: 16,
								width: 40,
								height: 40,
								background: "#fff",
								color: "#0078d7",
								fontSize: 28,
								fontWeight: "bold",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								zIndex: 10,
								transition: "background 0.2s, color 0.2s, border 0.2s",
							}}
							aria-label="Close"
							title="Close">
							×
						</button>
						<OcaSurveyForm
							surveyContent={(selectedModelInfo as OcaModelInfo)?.surveyContent}
							surveyId={(selectedModelInfo as OcaModelInfo)?.surveyId || "unknown-survey-id"}
							modelId={selectedModelId}
							modelVersion={selectedModelId}
						/>
					</div>
				</div>
			)}
		</div>
	)
}
