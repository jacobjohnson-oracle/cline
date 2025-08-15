import { Controller } from "../index"
import { OcaSurveyManager } from "./util/ocaSurveyManager"
import { getAllExtensionState } from "@/core/storage/state"
import { DEFAULT_SURVEY_PORT } from "./util/constants"
import { EmptyRequest, PortResponse } from "@/shared/proto/index.cline"
/**
 * Handles the user clicking the login link in the UI.
 * Performs the OAuth flow to obtain a token set,
 * which includes access and refresh tokens, as well as the expiration time.
 *
 * @param controller The controller instance.
 * @returns The login URL as a string.
 */
export async function ocaStartSurveyProxySurvey(controller: Controller, unused: EmptyRequest): Promise<PortResponse> {
	// Perform oca oauth flow to get token set
	console.log("Starting Survey Proxy Survey")
	const { apiConfiguration } = await getAllExtensionState(controller.context)
	const port = await OcaSurveyManager.startServer(DEFAULT_SURVEY_PORT, apiConfiguration?.ocaBaseUrl)
	if (!port) {
		throw new Error("Failed to start survey proxy server")
	}
	return PortResponse.create({
		port: port,
	})
}
