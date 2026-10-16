import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { DetailedError, Upload } from "tus-js-client";
import { keys } from "../../lib/api/keys";
import { UPLOAD_CHUNK_SIZE, UPLOAD_RETRY_DELAYS, uploadErrorMessage } from "../../lib/upload";

export type UploadStatus = "uploading" | "done" | "error" | "cancelled";

export interface UploadEntry {
  id: string;
  fileName: string;
  size: number;
  bytesUploaded: number;
  status: UploadStatus;
  error: string | null;
}

/**
 * Uploads live outside the page components so they keep running while the user moves around the
 * panel. A tiny external store feeds useSyncExternalStore.
 */
class UploadStore {
  private entries: UploadEntry[] = [];
  private readonly uploads = new Map<string, Upload>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(private readonly onFinished: () => void) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadEntry[] => this.entries;

  get active(): boolean {
    return this.entries.some((entry) => entry.status === "uploading");
  }

  private update(id: string, patch: Partial<UploadEntry>): void {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    for (const listener of this.listeners) listener();
  }

  add(files: readonly File[]): void {
    for (const file of files) this.start(file);
  }

  private start(file: File): void {
    const id = `u${this.nextId++}`;
    this.entries = [
      ...this.entries,
      { id, fileName: file.name, size: file.size, bytesUploaded: 0, status: "uploading", error: null },
    ];
    for (const listener of this.listeners) listener();

    const upload = new Upload(file, {
      endpoint: "/api/uploads",
      chunkSize: UPLOAD_CHUNK_SIZE,
      retryDelays: UPLOAD_RETRY_DELAYS,
      metadata: { filename: file.name, filetype: file.type === "" ? "application/octet-stream" : file.type },
      // Picking the same file again after a lost connection resumes it instead of starting over.
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      onProgress: (bytesUploaded) => this.update(id, { bytesUploaded }),
      onSuccess: () => {
        this.uploads.delete(id);
        this.update(id, { status: "done", bytesUploaded: file.size });
        this.onFinished();
      },
      onError: (error) => {
        this.uploads.delete(id);
        const response = error instanceof DetailedError ? error.originalResponse : null;
        this.update(id, {
          status: "error",
          error: uploadErrorMessage(response?.getStatus() ?? null, response?.getBody() ?? null),
        });
      },
    });
    this.uploads.set(id, upload);
    void upload
      .findPreviousUploads()
      .then((previous) => {
        const resumable = previous[0];
        if (resumable !== undefined) upload.resumeFromPreviousUpload(resumable);
      })
      .catch(() => undefined)
      .finally(() => {
        // Cancelled before it really started.
        if (this.uploads.has(id)) upload.start();
      });
  }

  cancel(id: string): void {
    const upload = this.uploads.get(id);
    this.uploads.delete(id);
    // Terminating lets the server drop the partial file; if it refuses, its cleanup handles it.
    if (upload !== undefined) void upload.abort(true).catch(() => undefined);
    this.update(id, { status: "cancelled" });
  }

  dismiss(id: string): void {
    if (this.uploads.has(id)) return;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    for (const listener of this.listeners) listener();
  }

  clearFinished(): void {
    this.entries = this.entries.filter((entry) => entry.status === "uploading");
    for (const listener of this.listeners) listener();
  }
}

const UploadContext = createContext<UploadStore | null>(null);

export function UploadProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const store = useMemo(
    () => new UploadStore(() => void queryClient.invalidateQueries({ queryKey: keys.media })),
    [queryClient],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (store.active) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);

  return <UploadContext.Provider value={store}>{children}</UploadContext.Provider>;
}

export function useUploads() {
  const store = useContext(UploadContext);
  if (store === null) throw new Error("useUploads must be used inside UploadProvider");
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    entries,
    add: (files: readonly File[]) => store.add(files),
    cancel: (id: string) => store.cancel(id),
    dismiss: (id: string) => store.dismiss(id),
    clearFinished: () => store.clearFinished(),
  };
}
