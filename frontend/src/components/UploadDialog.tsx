import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/errors";
import { audioWarning, readMatroskaTracks } from "../lib/matroska";
import {
  UPLOAD_KEY_STORAGE,
  subtitleFileProblem,
  uploadKeyProblem,
  uploadSubtitle,
  uploadVideo,
  videoProblem,
  type UploadProgress,
} from "../lib/upload";

interface Props {
  /** Kontrol yetkisi varsa sonuçta "Lobide aç" gösterilir. */
  canControl: boolean;
  onClose(): void;
  /** Videoyu (ve varsa altyazıyı) lobide açar; hata olursa reddeder (metni çağıran gösterir). */
  onOpenInLobby(videoUrl: string, subtitleUrl: string | null): Promise<void>;
}

type Phase =
  | { kind: "form" }
  | { kind: "uploading"; what: "video" | "subtitle"; progress: UploadProgress | null }
  | { kind: "done"; videoUrl: string; subtitleUrl: string | null };

function readStoredKey(): string {
  try {
    return localStorage.getItem(UPLOAD_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

function storeKey(key: string | null) {
  try {
    if (key) localStorage.setItem(UPLOAD_KEY_STORAGE, key);
    else localStorage.removeItem(UPLOAD_KEY_STORAGE);
  } catch {
    // depolama kapalı: hatırlanmaz, yükleme yine çalışır
  }
}

const mbPerSec = (bps: number) => (bps / (1024 * 1024)).toLocaleString("tr-TR", { maximumFractionDigits: 1 });

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${s % 60} sn`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="upload-link">
      <span className="muted small">{label}</span>
      <div className="upload-link-row">
        <input value={url} readOnly onFocus={(e) => e.target.select()} aria-label={label} />
        <button
          type="button"
          onClick={() =>
            navigator.clipboard
              .writeText(url)
              .then(() => setCopied(true))
              .catch(() => {})
          }
        >
          {copied ? "Kopyalandı" : "Kopyala"}
        </button>
      </div>
    </div>
  );
}

export function UploadDialog({ canControl, onClose, onOpenInLobby }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [key, setKey] = useState(readStoredKey);
  const [remember, setRemember] = useState(() => readStoredKey() !== "");
  const [video, setVideo] = useState<File | null>(null);
  const [subtitle, setSubtitle] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // MKV seçilince başlıktan okunan ses uyarısı; yüklemeyi engellemez.
  const [warning, setWarning] = useState<string | null>(null);
  const inspectRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    // Pencere kapanırken (bileşen kalkarken) süren yükleme iptal edilir.
    return () => {
      abortRef.current?.abort();
      inspectRef.current?.abort();
    };
  }, []);

  function pickVideo(file: File | null) {
    inspectRef.current?.abort();
    setVideo(file);
    setWarning(null);
    setProblem(null);
    if (!file || !file.name.toLowerCase().endsWith(".mkv")) return;
    const ctrl = new AbortController();
    inspectRef.current = ctrl;
    readMatroskaTracks(file, ctrl.signal)
      .then((r) => setWarning(audioWarning(r)))
      .catch(() => {}); // iptal: yeni dosya seçildi
  }

  const uploading = phase.kind === "uploading";

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedKey = key.trim();
    if (!trimmedKey) return setProblem("Yükleme anahtarını gir");
    const keyProblem = uploadKeyProblem(trimmedKey);
    if (keyProblem) return setProblem(keyProblem);
    if (!video) return setProblem("Bir video dosyası seç");
    const p = videoProblem(video) ?? (subtitle && subtitleFileProblem(subtitle));
    if (p) return setProblem(p);

    // "Hatırla" kapalıysa eski kayıt hemen silinir; açıksa anahtar ancak sunucu kabul edince yazılır.
    if (!remember) storeKey(null);
    setProblem(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      setPhase({ kind: "uploading", what: "video", progress: null });
      const v = await uploadVideo(video, trimmedKey, {
        signal: ctrl.signal,
        onStarted: () => {
          if (remember) storeKey(trimmedKey);
        },
        onProgress: (progress) => setPhase({ kind: "uploading", what: "video", progress }),
      });
      let subUrl: string | null = null;
      if (subtitle) {
        setPhase({ kind: "uploading", what: "subtitle", progress: null });
        const s = await uploadSubtitle(subtitle, trimmedKey, {
          signal: ctrl.signal,
          onProgress: (progress) => setPhase({ kind: "uploading", what: "subtitle", progress }),
        });
        subUrl = s.url;
      }
      setPhase({ kind: "done", videoUrl: v.url, subtitleUrl: subUrl });
    } catch (err) {
      setPhase({ kind: "form" });
      setProblem(ctrl.signal.aborted ? "Yükleme iptal edildi" : errorMessage(err));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  async function openInLobby(videoUrl: string, subtitleUrl: string | null) {
    setOpening(true);
    try {
      await onOpenInLobby(videoUrl, subtitleUrl);
      onClose();
    } catch {
      // Hata metnini çağıran gösterdi; linkler kopyalanabilsin diye pencere açık kalır.
    } finally {
      setOpening(false);
    }
  }

  const progress = phase.kind === "uploading" ? phase.progress : null;
  const percent = progress && progress.total > 0 ? Math.floor((progress.loaded / progress.total) * 100) : 0;

  return (
    <dialog
      ref={dialogRef}
      className="upload-dialog card"
      aria-labelledby="upload-title"
      onCancel={(e) => {
        // Escape: yükleme sürüyorsa önce iptal edilir, pencere açık kalır; yoksa kapanır.
        e.preventDefault();
        if (uploading) abortRef.current?.abort();
        else close();
      }}
    >
      <div className="upload-head">
        <h3 id="upload-title">Bilgisayardan yükle</h3>
        <button type="button" className="upload-close" onClick={close} aria-label="Kapat">
          ×
        </button>
      </div>

      {phase.kind === "done" ? (
        <div className="upload-done">
          <p className="upload-ok">Yükleme tamamlandı.</p>
          <CopyRow label="Video linki" url={phase.videoUrl} />
          {phase.subtitleUrl && <CopyRow label="Altyazı linki" url={phase.subtitleUrl} />}
          <div className="upload-actions">
            {canControl && (
              <button
                type="button"
                className="primary"
                disabled={opening}
                onClick={() => openInLobby(phase.videoUrl, phase.subtitleUrl)}
              >
                Lobide aç
              </button>
            )}
            <button type="button" onClick={close}>
              Kapat
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Yükleme anahtarı</span>
            <input
              type="password"
              className="upload-key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setProblem(null);
              }}
              autoComplete="off"
              autoFocus={!key}
              disabled={uploading}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={uploading} />
            <span>Bu tarayıcıda hatırla</span>
          </label>
          <label className="field">
            <span>Video (MP4 / MKV)</span>
            <input
              type="file"
              accept=".mp4,.m4v,.mkv,video/mp4,video/x-matroska"
              autoFocus={!!key}
              onChange={(e) => pickVideo(e.target.files?.[0] ?? null)}
              disabled={uploading}
            />
          </label>
          <label className="field">
            <span>Altyazı (.srt / .vtt, isteğe bağlı)</span>
            <input
              type="file"
              accept=".srt,.vtt"
              onChange={(e) => {
                setSubtitle(e.target.files?.[0] ?? null);
                setProblem(null);
              }}
              disabled={uploading}
            />
          </label>
          <p className="muted small">
            En iyi sonuç için H.264 video ve AAC ses içeren MP4 kullanın. MKV her tarayıcıda oynamaz (Chrome/Edge en uyumlu,
            Safari oynatmaz); MKV içindeki altyazı gösterilmez, ayrı .srt/.vtt ekleyin.
          </p>
          <div aria-live="polite">{warning && <p className="warn small">{warning}</p>}</div>

          {phase.kind === "uploading" && (
            <div className="upload-progress" aria-live="polite">
              <div
                className="upload-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={phase.what === "video" ? "Video yükleniyor" : "Altyazı yükleniyor"}
              >
                <div className="upload-bar-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="small upload-stats">
                <span>
                  {phase.what === "video" ? "Video" : "Altyazı"} %{percent}
                </span>
                {progress && progress.bytesPerSecond > 0 && <span>{mbPerSec(progress.bytesPerSecond)} MB/sn</span>}
                <span>
                  {progress?.secondsLeft != null ? `Kalan: ~${formatDuration(progress.secondsLeft)}` : "Kalan süre hesaplanıyor…"}
                </span>
              </p>
            </div>
          )}

          {problem && <p className="error small">{problem}</p>}

          <div className="upload-actions">
            {uploading ? (
              <button type="button" onClick={() => abortRef.current?.abort()}>
                İptal
              </button>
            ) : (
              <button className="primary" disabled={!video}>
                Yükle
              </button>
            )}
          </div>
        </form>
      )}
    </dialog>
  );
}
