export type {
  DashScopeEndpointPreset,
  SpeechConfigSnapshot,
  SpeechCredentialMode,
  SpeechErrorCode,
  SpeechHealth,
  SpeechMicrophoneRequestResult,
  SpeechMicrophoneStatus,
  SpeechPreferences,
  SpeechProviderConfig,
  SpeechProviderConfigUpdate,
  SpeechProviderKind,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTestDetail,
  SpeechTestRequest,
  SpeechTestResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SpeechTtsFormat,
  VolcengineAuthMode,
} from "../../../electron/shared/speechTypes";

import type {
  SpeechConfigSnapshot,
  SpeechMicrophoneRequestResult,
  SpeechMicrophoneStatus,
  SpeechPreferences,
  SpeechProviderConfig,
  SpeechProviderConfigUpdate,
  SpeechSynthesizeRequest,
  SpeechSynthesizeResult,
  SpeechTestRequest,
  SpeechTestResult,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
} from "../../../electron/shared/speechTypes";

function api() {
  const s = window.freebuddy?.speech;
  if (!s) throw new Error("speech bridge unavailable");
  return s;
}

export const speechClient = {
  isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      Boolean(window.freebuddy?.speech) &&
      window.freebuddy?.platform !== "web"
    );
  },

  getConfig(): Promise<SpeechConfigSnapshot> {
    return api().getConfig();
  },

  saveProvider(input: SpeechProviderConfigUpdate): Promise<SpeechProviderConfig> {
    return api().saveProvider(input);
  },

  savePreferences(patch: Partial<SpeechPreferences>): Promise<SpeechPreferences> {
    return api().savePreferences(patch);
  },

  testProvider(req: SpeechTestRequest): Promise<SpeechTestResult> {
    return api().testProvider(req);
  },

  transcribe(req: SpeechTranscribeRequest): Promise<SpeechTranscribeResult> {
    return api().transcribe(req);
  },

  synthesize(req: SpeechSynthesizeRequest): Promise<SpeechSynthesizeResult> {
    return api().synthesize(req);
  },

  cancel(requestId: string): Promise<boolean> {
    return api().cancel(requestId);
  },

  microphoneStatus(): Promise<SpeechMicrophoneStatus> {
    return api().microphoneStatus();
  },

  requestMicrophone(): Promise<SpeechMicrophoneRequestResult> {
    return api().requestMicrophone();
  },
};
