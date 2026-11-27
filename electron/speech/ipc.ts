import { systemPreferences } from "electron";
import { registerHandler } from "../invokeRegistry.js";
import type {
  SpeechMicrophoneRequestResult,
  SpeechMicrophoneStatus,
  SpeechPreferences,
  SpeechProviderConfigUpdate,
  SpeechSynthesizeRequest,
  SpeechTestRequest,
  SpeechTranscribeRequest,
} from "../shared/speechTypes.js";
import {
  cancelSpeechRequest,
  synthesizeSpeech,
  testSpeechProvider,
  transcribeSpeech,
} from "./service.js";
import {
  getSpeechConfig,
  saveSpeechPreferences,
  saveSpeechProvider,
} from "./storage.js";

function normalizeMacMicStatus(raw: string): SpeechMicrophoneStatus["status"] {
  if (
    raw === "granted" ||
    raw === "denied" ||
    raw === "restricted" ||
    raw === "not-determined"
  ) {
    return raw;
  }
  return "unknown";
}

export function getMicrophoneStatus(): SpeechMicrophoneStatus {
  if (process.platform === "darwin") {
    return {
      platform: process.platform,
      status: normalizeMacMicStatus(systemPreferences.getMediaAccessStatus("microphone")),
    };
  }
  return {
    platform: process.platform,
    status: "granted",
  };
}

export async function requestMicrophonePermission(): Promise<SpeechMicrophoneRequestResult> {
  if (process.platform === "darwin") {
    const current = getMicrophoneStatus().status;
    if (current === "granted") {
      return { granted: true, status: "granted" };
    }
    const granted = await systemPreferences.askForMediaAccess("microphone");
    const status = getMicrophoneStatus().status;
    return { granted, status };
  }
  return { granted: true, status: "granted" };
}

export function registerSpeechIpc(): void {
  registerHandler("speech:getConfig", () => getSpeechConfig());
  registerHandler("speech:saveProvider", (_e, input: SpeechProviderConfigUpdate) =>
    saveSpeechProvider(input)
  );
  registerHandler("speech:savePreferences", (_e, patch: Partial<SpeechPreferences>) =>
    saveSpeechPreferences(patch)
  );
  registerHandler("speech:testProvider", (_e, req: SpeechTestRequest) =>
    testSpeechProvider(req)
  );
  registerHandler("speech:transcribe", (_e, req: SpeechTranscribeRequest) =>
    transcribeSpeech(req)
  );
  registerHandler("speech:synthesize", (_e, req: SpeechSynthesizeRequest) =>
    synthesizeSpeech(req)
  );
  registerHandler("speech:cancel", (_e, requestId: string) =>
    cancelSpeechRequest(String(requestId ?? ""))
  );
  registerHandler("speech:microphoneStatus", () => getMicrophoneStatus());
  registerHandler("speech:requestMicrophone", () => requestMicrophonePermission());
}
