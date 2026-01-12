import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { Controller } from "../index"

export async function ocaStartDeviceAuth(controller: Controller, _: EmptyRequest): Promise<Empty> {
	// Fire-and-forget so the unary RPC returns immediately; the DeviceAuth details will arrive via the stream.
	void OcaAuthService.getInstance().deviceCodeAuth()
	return Empty.create()
}
