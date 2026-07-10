export type PreparedAttachmentBatch<TCandidate, TRejection> = {
  candidates: TCandidate[];
  rejections: TRejection[];
};

export type CollectPreparedAttachmentsOptions<TCandidate> = {
  getCandidatePath?: (candidate: TCandidate) => string | null | undefined;
  existingPaths?: readonly string[];
  onSkippedCandidate?: (candidate: TCandidate, reason: "duplicate" | "overflow") => void;
};

export async function collectPreparedAttachmentsUntilLimit<TFile, TCandidate, TRejection>(
  files: readonly TFile[],
  limit: number | undefined,
  prepareFile: (file: TFile) => Promise<PreparedAttachmentBatch<TCandidate, TRejection>>,
  options?: CollectPreparedAttachmentsOptions<TCandidate>
): Promise<PreparedAttachmentBatch<TCandidate, TRejection> & { overflow: boolean }> {
  const candidates: TCandidate[] = [];
  const rejections: TRejection[] = [];
  const acceptedPaths = new Set(options?.existingPaths ?? []);
  const getPath = options?.getCandidatePath;
  let overflow = false;

  for (const file of files) {
    const batch = await prepareFile(file);
    rejections.push(...batch.rejections);

    for (const candidate of batch.candidates) {
      const candidatePath = getPath?.(candidate) ?? null;
      if (candidatePath && acceptedPaths.has(candidatePath)) {
        options?.onSkippedCandidate?.(candidate, "duplicate");
        continue;
      }
      if (typeof limit === "number" && candidates.length >= limit) {
        overflow = true;
        options?.onSkippedCandidate?.(candidate, "overflow");
        continue;
      }
      candidates.push(candidate);
      if (candidatePath) acceptedPaths.add(candidatePath);
    }
  }

  return { candidates, rejections, overflow };
}

export function managedPathsToDiscardAfterPrepare(
  createdManagedPaths: readonly string[],
  acceptedCandidates: readonly { managed?: boolean; created?: boolean; path?: string }[]
): string[] {
  const acceptedPaths = new Set(
    acceptedCandidates
      .filter(
        (candidate) =>
          candidate.created &&
          candidate.managed &&
          typeof candidate.path === "string"
      )
      .map((candidate) => candidate.path as string)
  );
  return createdManagedPaths.filter((managedPath) => !acceptedPaths.has(managedPath));
}
