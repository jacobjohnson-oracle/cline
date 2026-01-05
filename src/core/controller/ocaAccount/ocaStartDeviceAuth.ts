import { EmptyRequest } from "@shared/proto/cline/common"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { Controller } from "../index"

export async function ocaStartDeviceAuth(controller: Controller, _: EmptyRequest): Promise<OcaDeviceAuthStartResponse> {
	return await OcaAuthService.getInstance().startDeviceAuth(controller)
}
