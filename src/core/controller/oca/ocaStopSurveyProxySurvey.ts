import { Empty, EmptyRequest } from "@/shared/proto/index.cline"
import { Controller } from "../index"
import { OcaSurveyManager } from "./util/ocaSurveyManager"
/**
 * Handles the user clicking the login link in the UI.
 * Performs the OAuth flow to obtain a token set,
 * which includes access and refresh tokens, as well as the expiration time.
 *
 * @param controller The controller instance.
 * @returns The login URL as a string.
 */
export async function ocaStopSurveyProxySurvey(controller: Controller, unused: EmptyRequest): Promise<Empty> {
	// Perform oca oauth flow to get token set
	console.log("Stopping Survey Proxy Survey")
	await OcaSurveyManager.stopServer()
	return Empty.create({})
}
