import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { Controller } from "../index"

// ocaPollDeviceAuth.ts
export async function ocaPollDeviceAuth(controller: Controller, request: OcaDeviceAuthPollRequest): Promise<OcaAuthState> {
	return await OcaAuthService.getInstance().pollDeviceAuth(controller, request.device_code)
}
