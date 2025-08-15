import { GenerateSurveyHtmlRequest, GenerateSurveyHtmlResponse } from "@/shared/proto/index.cline"
import { Controller } from "../index"
import { OcaSurveyManager } from "./util/ocaSurveyManager"
/**
 * Handles creation of a survey HTML file from a template and params.
 *
 * @param controller The controller instance.
 * @param req The request containing the surveyHtml, modelId, client, and clientVersion.
 * @returns An object containing file path and survey URL.
 */
export async function ocaGenerateSurveyHtml(
	controller: Controller,
	req: GenerateSurveyHtmlRequest,
): Promise<GenerateSurveyHtmlResponse> {
	console.log("Generating Survey HTML with", {
		modelId: req.modelId,
		client: req.client,
		clientVersion: req.clientVersion,
	})
	// Make sure the survey server is running
	let port = OcaSurveyManager.serverPort
	if (!port) {
		// Optionally, you could choose to start it with OcaSurveyManager.startServer() if you'd like to auto-run
		throw new Error("Survey server is not running. Start the survey server before generating survey HTML.")
	}
	const filePath = OcaSurveyManager.createSurveyHtml({
		surveyHtml: req.surveyHtml || "<div>NO SURVEY</div>",
		surveyId: req.surveyId,
		modelId: req.modelId,
		client: req.client,
		clientVersion: req.clientVersion,
		port,
	})
	return GenerateSurveyHtmlResponse.create({
		filePath,
		url: `http://localhost:${port}/survey`,
	})
}
