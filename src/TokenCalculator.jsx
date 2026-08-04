import { useState, useRef, useEffect, useMemo } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Timer,
  Zap,
  Gauge,
  Activity,
  AlignLeft,
  Code2,
  Braces,
  Pencil,
} from "lucide-react";

/* ---------------------------------------------------------------- */
/* Sample content                                                    */
/* ---------------------------------------------------------------- */

const SAMPLE_PROSE = `Large language models don't write like people do. They generate one token at a time, each token a fragment of a word, a whole word, or a piece of punctuation, predicted from everything that came before it. When you send a prompt, the model spends a moment turning your words into an internal representation, running that pattern through billions of parameters, and only then does the very first token appear. That pause is time to first token, and it can stretch from a few dozen milliseconds on a fast, warm GPU to several seconds on a cold, overloaded server or a reasoning model working through a hidden chain of thought. Once the first token lands, the model settles into a rhythm, producing token after token at a pace measured in tokens per second. A number like forty tokens per second sounds abstract until you watch it happen: words appear in short, steady bursts, sentences assemble themselves in real time, and the whole paragraph builds itself out of pieces too small to read on their own. Slow that rhythm down and the same words feel like they're being typed by someone thinking hard. Speed it up and the response feels instant, almost like the text was there all along, waiting to be revealed.`;

const SAMPLE_CODE = `import time

def stream_tokens(tokens, ttft_ms, tokens_per_sec):
    """Yield tokens one at a time, honoring time-to-first-token
    and a steady output rate. Mirrors the pacing of an LLM's
    streaming API response."""
    start = time.perf_counter()
    time.sleep(ttft_ms / 1000)

    interval = 1.0 / tokens_per_sec
    for i, token in enumerate(tokens):
        target = start + (ttft_ms / 1000) + i * interval
        now = time.perf_counter()
        if target > now:
            time.sleep(target - now)
        yield token


def render(tokens, ttft_ms=500, tokens_per_sec=40):
    buffer = []
    for token in stream_tokens(tokens, ttft_ms, tokens_per_sec):
        buffer.append(token)
        print("".join(buffer), end="\\r", flush=True)
    print()
    return "".join(buffer)


class RateMonitor:
    """Tracks a rolling tokens/sec estimate while streaming."""

    def __init__(self, window=20):
        self.window = window
        self.timestamps = []

    def tick(self):
        now = time.perf_counter()
        self.timestamps.append(now)
        if len(self.timestamps) > self.window:
            self.timestamps.pop(0)
        if len(self.timestamps) < 2:
            return 0.0
        elapsed = self.timestamps[-1] - self.timestamps[0]
        return (len(self.timestamps) - 1) / elapsed if elapsed > 0 else 0.0`;

const SAMPLE_JSON = `{
  "model": "demo-llm-7b",
  "stream": true,
  "metrics": {
    "time_to_first_token_ms": 480,
    "tokens_per_second": 42.7,
    "total_tokens": 256,
    "total_duration_ms": 6450
  },
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "delta": {
        "role": "assistant",
        "content": "Streaming responses arrive as a sequence of small events."
      }
    }
  ],
  "usage": {
    "prompt_tokens": 34,
    "completion_tokens": 256,
    "total_tokens": 290
  },
  "system_fingerprint": "demo-9f21a3",
  "created": 1735776000
}`;

const CONTENT_TABS = [
  { id: "prose", label: "Prose", icon: AlignLeft },
  { id: "code", label: "Code", icon: Code2 },
  { id: "json", label: "JSON", icon: Braces },
  { id: "custom", label: "Custom", icon: Pencil },
];

const TTFT_PRESETS = [0, 100, 250, 500, 1000, 2000, 5000];
const TPS_PRESETS = [5, 10, 20, 30, 50, 75, 100, 200];

const STATUS_LABEL = {
  idle: "READY",
  waiting: "WAITING FOR FIRST TOKEN",
  streaming: "STREAMING",
  done: "COMPLETE",
};

/* ---------------------------------------------------------------- */
/* Tokenizer (approximation for demo purposes)                       */
/* ---------------------------------------------------------------- */

function tokenize(text) {
  if (!text) return [];
  const re = /\s*[A-Za-z0-9]+|\s*[^\sA-Za-z0-9]+|\s+/g;
  const raw = text.match(re) || [];
  const lens = [3, 4, 3, 5, 4];
  const tokens = [];
  for (const piece of raw) {
    const m = piece.match(/^(\s*)([\s\S]*)$/);
    const ws = m[1];
    const body = m[2];
    if (/^[A-Za-z0-9]+$/.test(body) && body.length > 4) {
      let i = 0;
      let chunkIdx = 0;
      let first = true;
      while (i < body.length) {
        const len = Math.min(lens[chunkIdx % lens.length], body.length - i);
        tokens.push(first ? ws + body.slice(i, i + len) : body.slice(i, i + len));
        first = false;
        i += len;
        chunkIdx++;
      }
    } else {
      tokens.push(piece);
    }
  }
  return tokens;
}

function buildTokens(base, target) {
  if (!target || target <= 0 || base.length === 0) return base;
  if (base.length >= target) return base.slice(0, target);
  const out = [];
  while (out.length < target) {
    if (out.length > 0) out.push("\n\n");
    for (const t of base) {
      if (out.length >= target) break;
      out.push(t);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Formatting helpers                                                */
/* ---------------------------------------------------------------- */

function formatMsShort(ms) {
  if (!isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatDurationLong(ms) {
  if (!isFinite(ms) || ms < 0) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = (totalSeconds - mins * 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

function chipLabelMs(v) {
  return v >= 1000 ? `${v / 1000}s` : `${v}ms`;
}

/* ---------------------------------------------------------------- */
/* Component                                                         */
/* ---------------------------------------------------------------- */

export default function TokenCalculator() {
  const [ttft, setTtft] = useState(500);
  const [tps, setTps] = useState(40);
  const [contentType, setContentType] = useState("prose");
  const [customText, setCustomText] = useState(
    "Type or paste your own text here to see how it streams..."
  );
  const [targetTokens, setTargetTokens] = useState(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [visibleCount, setVisibleCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const rafRef = useRef(null);
  const startRef = useRef(null);
  const pausedElapsedRef = useRef(0);
  const monitorRef = useRef(null);

  const sourceText =
    contentType === "custom"
      ? customText
      : contentType === "prose"
      ? SAMPLE_PROSE
      : contentType === "code"
      ? SAMPLE_CODE
      : SAMPLE_JSON;

  const baseTokens = useMemo(() => tokenize(sourceText || ""), [sourceText]);
  const tokens = useMemo(
    () => buildTokens(baseTokens, targetTokens),
    [baseTokens, targetTokens]
  );
  const totalTokens = tokens.length;

  const streamDurationMs =
    Math.max(0, totalTokens - 1) * (1000 / Math.max(tps, 0.01));
  const totalTimeMs = totalTokens > 0 ? ttft + streamDurationMs : 0;
  const effectiveTps =
    totalTokens > 0 && totalTimeMs > 0
      ? totalTokens / (totalTimeMs / 1000)
      : 0;
  const diffPercent = tps > 0 ? (1 - effectiveTps / tps) * 100 : 0;

  const displayedText = useMemo(
    () => tokens.slice(0, visibleCount).join(""),
    [tokens, visibleCount]
  );

  // Reset playback whenever the source content changes
  useEffect(() => {
    setIsPlaying(false);
    setPhase("idle");
    setVisibleCount(0);
    setElapsed(0);
    startRef.current = null;
    pausedElapsedRef.current = 0;
  }, [contentType, customText, targetTokens]);

  // Animation loop
  useEffect(() => {
    if (!isPlaying) return;

    function tick(now) {
      if (startRef.current === null) startRef.current = now - pausedElapsedRef.current;
      const elapsedMs = now - startRef.current;
      setElapsed(elapsedMs);

      if (elapsedMs < ttft) {
        setPhase("waiting");
      } else {
        setPhase("streaming");
        const interval = 1000 / Math.max(tps, 0.01);
        const tokensElapsed = Math.floor((elapsedMs - ttft) / interval) + 1;
        const count = Math.min(totalTokens, tokensElapsed);
        setVisibleCount((prev) => Math.max(prev, count));
        if (count >= totalTokens) {
          setPhase("done");
          setIsPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [isPlaying, ttft, tps, totalTokens]);

  // Auto-scroll monitor
  useEffect(() => {
    if (monitorRef.current) monitorRef.current.scrollTop = monitorRef.current.scrollHeight;
  }, [displayedText]);

  function handlePlay() {
    if (totalTokens === 0) return;
    if (phase === "done") {
      setVisibleCount(0);
      setElapsed(0);
      pausedElapsedRef.current = 0;
      startRef.current = null;
      setPhase("idle");
    } else {
      pausedElapsedRef.current = elapsed;
      startRef.current = null;
    }
    setIsPlaying(true);
  }

  function handlePause() {
    setIsPlaying(false);
  }

  function handleReset() {
    setIsPlaying(false);
    setPhase("idle");
    setVisibleCount(0);
    setElapsed(0);
    startRef.current = null;
    pausedElapsedRef.current = 0;
  }

  function handleTtftChange(v) {
    const n = Number(v);
    setTtft(isNaN(n) ? 0 : Math.max(0, n));
  }

  function handleTpsChange(v) {
    const n = Number(v);
    setTps(isNaN(n) ? 0.1 : Math.max(0.1, n));
  }

  const ttftPct = Math.min(100, (ttft / 5000) * 100);
  const tpsPct = Math.min(100, (tps / 300) * 100);

  return (
    <div className="tc-root">
      <style>{CSS}</style>
      <div className="tc-scanlines" aria-hidden="true" />
      <div className="tc-vignette" aria-hidden="true" />

      <div className="tc-container">
        <header className="tc-header">
          <div className="tc-title-row">
            <Activity className="tc-title-icon" size={26} />
            <h1 className="tc-title">TOKEN CALCULATOR</h1>
          </div>
          <p className="tc-subtitle">See what "tokens/sec" actually feels like</p>
        </header>

        <div className="tc-grid">
          {/* LEFT COLUMN — CONTROLS */}
          <div className="tc-col-left">
            <section className="tc-card">
              <div className="tc-card-title">
                <Timer size={15} /> TIME TO FIRST TOKEN
              </div>
              <div className="tc-readout tc-readout-amber">
                {formatMsShort(ttft)}
                {ttft >= 1000 && <span className="tc-readout-sub">{ttft}ms</span>}
              </div>
              <input
                type="range"
                min={0}
                max={5000}
                step={10}
                value={ttft}
                onChange={(e) => handleTtftChange(e.target.value)}
                className="tc-slider"
                style={{
                  background: `linear-gradient(to right, var(--amber) ${ttftPct}%, rgba(255,255,255,0.08) ${ttftPct}%)`,
                }}
              />
              <div className="tc-control-row">
                <input
                  type="number"
                  min={0}
                  value={ttft}
                  onChange={(e) => handleTtftChange(e.target.value)}
                  className="tc-number-input"
                />
                <span className="tc-unit">ms</span>
              </div>
              <div className="tc-chip-row">
                {TTFT_PRESETS.map((p) => (
                  <button
                    key={p}
                    className={`tc-chip ${ttft === p ? "active" : ""}`}
                    onClick={() => setTtft(p)}
                  >
                    {chipLabelMs(p)}
                  </button>
                ))}
              </div>
            </section>

            <section className="tc-card">
              <div className="tc-card-title">
                <Zap size={15} /> TOKENS PER SECOND
              </div>
              <div className="tc-readout tc-readout-green">
                {tps % 1 === 0 ? tps : tps.toFixed(1)}
                <span className="tc-readout-sub">tok/s</span>
              </div>
              <input
                type="range"
                min={1}
                max={300}
                step={1}
                value={Math.min(tps, 300)}
                onChange={(e) => handleTpsChange(e.target.value)}
                className="tc-slider"
                style={{
                  background: `linear-gradient(to right, var(--green) ${tpsPct}%, rgba(255,255,255,0.08) ${tpsPct}%)`,
                }}
              />
              <div className="tc-control-row">
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={tps}
                  onChange={(e) => handleTpsChange(e.target.value)}
                  className="tc-number-input"
                />
                <span className="tc-unit">tok/s</span>
              </div>
              <div className="tc-chip-row">
                {TPS_PRESETS.map((p) => (
                  <button
                    key={p}
                    className={`tc-chip ${tps === p ? "active" : ""}`}
                    onClick={() => setTps(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </section>

            <section className="tc-card">
              <div className="tc-card-title">
                <AlignLeft size={15} /> SAMPLE TEXT
              </div>
              <div className="tc-tabs">
                {CONTENT_TABS.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      className={`tc-tab ${contentType === tab.id ? "active" : ""}`}
                      onClick={() => setContentType(tab.id)}
                    >
                      <Icon size={13} /> {tab.label}
                    </button>
                  );
                })}
              </div>

              {contentType === "custom" && (
                <textarea
                  className="tc-textarea"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="Paste or type your own text..."
                />
              )}

              <div className="tc-field">
                <label className="tc-field-label">Output length (tokens)</label>
                <input
                  type="number"
                  min={1}
                  placeholder={`${baseTokens.length}`}
                  value={targetTokens ?? ""}
                  onChange={(e) =>
                    setTargetTokens(e.target.value ? Math.max(1, Number(e.target.value)) : null)
                  }
                  className="tc-number-input tc-number-input-wide"
                />
              </div>
              <div className="tc-hint">
                Sample is ≈{baseTokens.length} tokens · output set to ≈{totalTokens} tokens
                {targetTokens ? " (custom target)" : " (natural length)"}
              </div>
            </section>
          </div>

          {/* RIGHT COLUMN — PLAYER + CALCULATOR */}
          <div className="tc-col-right">
            <section className="tc-card tc-monitor-card">
              <div className="tc-monitor-header">
                <span className={`tc-status-dot tc-status-${phase}`} />
                <span className="tc-status-label">{STATUS_LABEL[phase]}</span>
                <span className="tc-monitor-counter">
                  {visibleCount} / {totalTokens}
                </span>
              </div>

              <div className="tc-monitor-body" ref={monitorRef}>
                {totalTokens === 0 ? (
                  <span className="tc-placeholder">Add some text to begin...</span>
                ) : (
                  <>
                    <span className="tc-stream-text">{displayedText}</span>
                    <span className={`tc-cursor ${phase === "streaming" ? "tc-cursor-solid" : ""}`}>
                      ▍
                    </span>
                  </>
                )}
              </div>

              <div className="tc-progress-track">
                <div
                  className="tc-progress-fill"
                  style={{ width: `${totalTokens ? (visibleCount / totalTokens) * 100 : 0}%` }}
                />
              </div>

              <div className="tc-stats-row">
                <div className="tc-stat">
                  <div className="tc-stat-value">
                    {phase === "idle" ? "—" : formatMsShort(elapsed)}
                  </div>
                  <div className="tc-stat-label">ELAPSED</div>
                </div>
                <div className="tc-stat">
                  <div className="tc-stat-value">
                    {phase === "streaming" || phase === "done"
                      ? `${tps % 1 === 0 ? tps : tps.toFixed(1)}`
                      : "—"}
                  </div>
                  <div className="tc-stat-label">LIVE TOK/S</div>
                </div>
                <div className="tc-stat">
                  <div className="tc-stat-value">
                    {phase === "done" ? "DONE" : formatMsShort(Math.max(0, totalTimeMs - elapsed))}
                  </div>
                  <div className="tc-stat-label">ETA</div>
                </div>
              </div>

              <div className="tc-transport">
                <button className="tc-btn tc-btn-icon" onClick={handleReset} aria-label="Reset">
                  <RotateCcw size={18} />
                </button>
                <button
                  className="tc-btn tc-btn-primary"
                  onClick={isPlaying ? handlePause : handlePlay}
                  disabled={totalTokens === 0}
                >
                  {isPlaying ? (
                    <>
                      <Pause size={18} /> PAUSE
                    </>
                  ) : (
                    <>
                      <Play size={18} />{" "}
                      {phase === "done" ? "REPLAY" : phase === "idle" ? "PLAY" : "RESUME"}
                    </>
                  )}
                </button>
              </div>
            </section>

            <section className="tc-card tc-calc-card">
              <div className="tc-card-title">
                <Gauge size={15} /> CALCULATOR
              </div>
              <div className="tc-calc-headline">{formatDurationLong(totalTimeMs)}</div>
              <div className="tc-calc-sub">total time for {totalTokens} tokens</div>

              <div className="tc-calc-formula">
                <span>{formatMsShort(ttft)}</span>
                <span className="tc-calc-op">+</span>
                <span>
                  {Math.max(0, totalTokens - 1)} × {(1000 / Math.max(tps, 0.01)).toFixed(1)}ms
                </span>
                <span className="tc-calc-op">=</span>
                <span className="tc-calc-result">{formatMsShort(totalTimeMs)}</span>
              </div>

              {totalTokens > 0 && Math.abs(diffPercent) > 1 && (
                <div className="tc-insight">
                  {diffPercent > 0 ? (
                    <>
                      Counting the {formatMsShort(ttft)} wait for the first token, this response's{" "}
                      <strong>effective rate is {effectiveTps.toFixed(1)} tok/s</strong> —{" "}
                      {Math.round(diffPercent)}% below the steady {tps % 1 === 0 ? tps : tps.toFixed(1)}{" "}
                      tok/s the model is actually generating at.
                    </>
                  ) : (
                    <>
                      With only {totalTokens} token{totalTokens > 1 ? "s" : ""} and a short wait, the{" "}
                      <strong>effective rate ({effectiveTps.toFixed(1)} tok/s)</strong> comes out above
                      the steady {tps % 1 === 0 ? tps : tps.toFixed(1)} tok/s rate — there's barely
                      enough output for the pace to settle.
                    </>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>

        <footer className="tc-footer">
          Token splits are an approximation for demonstration — real tokenizers vary by model.
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Styles                                                            */
/* ---------------------------------------------------------------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.tc-root {
  --bg: #07090a;
  --panel: rgba(20,23,18,0.55);
  --border: rgba(255,182,39,0.16);
  --border-strong: rgba(255,182,39,0.4);
  --amber: #ffb627;
  --green: #4dff88;
  --cyan: #7fe7ff;
  --text: #eef0e6;
  --muted: #7d847a;
  --mono: 'IBM Plex Mono', ui-monospace, monospace;
  --display: 'Rajdhani', sans-serif;

  min-height: 100vh;
  width: 100%;
  background:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgba(255,182,39,0.07), transparent),
    radial-gradient(ellipse 60% 50% at 100% 100%, rgba(127,231,255,0.05), transparent),
    var(--bg);
  color: var(--text);
  font-family: var(--mono);
  position: relative;
  overflow-x: hidden;
  padding-bottom: 40px;
  box-sizing: border-box;
}
.tc-root *, .tc-root *::before, .tc-root *::after { box-sizing: border-box; }

.tc-scanlines {
  position: absolute; inset: 0; pointer-events: none; z-index: 5;
  background: repeating-linear-gradient(to bottom, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px);
  mix-blend-mode: overlay;
}
.tc-vignette {
  position: absolute; inset: 0; pointer-events: none; z-index: 4;
  background: radial-gradient(ellipse 120% 90% at 50% 30%, transparent 45%, rgba(0,0,0,0.5) 100%);
}

.tc-container { max-width: 1180px; margin: 0 auto; padding: 32px 24px; position: relative; z-index: 10; }

.tc-header { animation: tc-fadeup .5s ease both; margin-bottom: 8px; }
.tc-title-row { display: flex; align-items: center; gap: 10px; }
.tc-title-icon { color: var(--green); filter: drop-shadow(0 0 6px rgba(77,255,136,0.6)); animation: tc-pulse 2.4s ease-in-out infinite; }
.tc-title {
  font-family: var(--display); font-weight: 700; letter-spacing: 0.08em;
  font-size: clamp(24px, 5vw, 38px); margin: 0; color: var(--amber);
  text-shadow: 0 0 22px rgba(255,182,39,0.4);
}
.tc-subtitle { color: var(--muted); font-size: 13px; margin: 8px 0 0; letter-spacing: 0.03em; }

.tc-grid { display: grid; grid-template-columns: 1fr; gap: 20px; margin-top: 28px; }
@media (min-width: 960px) {
  .tc-grid { grid-template-columns: 380px 1fr; align-items: start; }
  .tc-col-left { position: sticky; top: 20px; }
}
.tc-col-left, .tc-col-right { display: flex; flex-direction: column; gap: 20px; min-width: 0; }

.tc-card {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 20px; backdrop-filter: blur(8px); animation: tc-fadeup .45s ease both;
}
.tc-card-title {
  display: flex; align-items: center; gap: 8px; font-family: var(--display);
  font-weight: 600; letter-spacing: 0.12em; font-size: 13px; color: var(--amber);
  text-transform: uppercase; margin-bottom: 16px;
}

.tc-readout { font-family: var(--mono); font-size: 32px; font-weight: 600; margin-bottom: 10px; line-height: 1; display: flex; align-items: baseline; gap: 8px; }
.tc-readout-amber { color: var(--amber); text-shadow: 0 0 16px rgba(255,182,39,0.35); }
.tc-readout-green { color: var(--green); text-shadow: 0 0 16px rgba(77,255,136,0.35); }
.tc-readout-sub { font-size: 13px; color: var(--muted); font-weight: 400; }

.tc-slider {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
  border-radius: 2px; outline: none; margin: 14px 0 10px; cursor: pointer;
}
.tc-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%;
  background: var(--text); box-shadow: 0 0 0 3px rgba(255,255,255,0.12), 0 0 12px rgba(255,182,39,0.5);
  cursor: pointer; transition: transform .15s ease; border: none;
}
.tc-slider::-webkit-slider-thumb:hover { transform: scale(1.15); }
.tc-slider::-moz-range-thumb {
  width: 18px; height: 18px; border-radius: 50%; background: var(--text); border: none;
  box-shadow: 0 0 12px rgba(255,182,39,0.5);
}
.tc-slider::-moz-range-track { height: 4px; border-radius: 2px; background: transparent; }

.tc-control-row { display: flex; align-items: center; gap: 8px; }
.tc-number-input {
  background: rgba(0,0,0,0.35); border: 1px solid var(--border); color: var(--text);
  font-family: var(--mono); font-size: 14px; padding: 8px 10px; border-radius: 6px;
  width: 90px; min-width: 0;
}
.tc-number-input:focus { outline: none; border-color: var(--border-strong); }
.tc-number-input-wide { width: 100%; }
.tc-unit { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }

.tc-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.tc-chip {
  background: transparent; border: 1px solid var(--border); color: var(--muted);
  font-family: var(--mono); font-size: 12px; padding: 5px 11px; border-radius: 20px;
  cursor: pointer; transition: all .15s ease;
}
.tc-chip:hover { border-color: var(--border-strong); color: var(--text); }
.tc-chip.active { background: rgba(255,182,39,0.14); border-color: var(--amber); color: var(--amber); }

.tc-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
.tc-tab {
  display: flex; align-items: center; gap: 6px; background: transparent;
  border: 1px solid var(--border); color: var(--muted); padding: 7px 12px;
  border-radius: 6px; font-family: var(--display); font-weight: 600; font-size: 13px;
  letter-spacing: 0.03em; cursor: pointer; transition: all .15s ease;
}
.tc-tab:hover { color: var(--text); border-color: var(--border-strong); }
.tc-tab.active { background: rgba(255,182,39,0.12); border-color: var(--amber); color: var(--amber); }

.tc-textarea {
  width: 100%; min-height: 100px; background: rgba(0,0,0,0.35); border: 1px solid var(--border);
  color: var(--text); font-family: var(--mono); font-size: 13px; padding: 10px;
  border-radius: 6px; resize: vertical; margin-bottom: 14px;
}
.tc-textarea:focus { outline: none; border-color: var(--border-strong); }

.tc-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.tc-field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.tc-hint { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.5; }

.tc-monitor-card { padding: 0; overflow: hidden; }
.tc-monitor-header {
  display: flex; align-items: center; gap: 8px; padding: 14px 18px;
  border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.25);
}
.tc-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.tc-status-idle { background: var(--muted); }
.tc-status-waiting { background: var(--amber); box-shadow: 0 0 8px var(--amber); animation: tc-pulse 1s ease-in-out infinite; }
.tc-status-streaming { background: var(--green); box-shadow: 0 0 8px var(--green); animation: tc-pulse .6s ease-in-out infinite; }
.tc-status-done { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); }
.tc-status-label { font-family: var(--display); font-weight: 600; letter-spacing: 0.1em; font-size: 12px; text-transform: uppercase; }
.tc-monitor-counter { margin-left: auto; font-size: 12px; color: var(--muted); }

.tc-monitor-body {
  padding: 20px; min-height: 220px; max-height: 340px; overflow-y: auto;
  font-size: 15px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
}
.tc-placeholder { color: var(--muted); font-style: italic; }
.tc-stream-text { color: var(--text); }
.tc-cursor { display: inline-block; color: var(--green); animation: tc-blink 1s step-start infinite; }
.tc-cursor-solid { animation: none; opacity: 1; }

.tc-progress-track { height: 3px; background: rgba(255,255,255,0.06); }
.tc-progress-fill { height: 100%; background: linear-gradient(to right, var(--amber), var(--green)); }

.tc-stats-row { display: flex; border-top: 1px solid var(--border); }
.tc-stat { flex: 1; text-align: center; padding: 14px 8px; border-right: 1px solid var(--border); min-width: 0; }
.tc-stat:last-child { border-right: none; }
.tc-stat-value { font-size: 17px; font-weight: 600; color: var(--text); font-family: var(--mono); }
.tc-stat-label { font-size: 10px; color: var(--muted); letter-spacing: 0.1em; margin-top: 4px; }

.tc-transport { display: flex; gap: 10px; padding: 16px 18px; border-top: 1px solid var(--border); }
.tc-btn {
  font-family: var(--display); font-weight: 600; letter-spacing: 0.06em; border-radius: 8px;
  cursor: pointer; transition: all .15s ease; display: flex; align-items: center;
  justify-content: center; gap: 8px; border: 1px solid var(--border); background: transparent;
}
.tc-btn:active { transform: scale(0.97); }
.tc-btn-icon { color: var(--muted); width: 46px; height: 46px; padding: 0; flex-shrink: 0; }
.tc-btn-icon:hover { color: var(--text); border-color: var(--border-strong); }
.tc-btn-primary {
  flex: 1; background: rgba(77,255,136,0.12); border-color: var(--green); color: var(--green);
  height: 46px; font-size: 14px; text-transform: uppercase;
}
.tc-btn-primary:hover:not(:disabled) { background: rgba(77,255,136,0.2); }
.tc-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

.tc-calc-headline {
  font-size: clamp(28px, 6vw, 40px); font-weight: 700; color: var(--cyan);
  text-shadow: 0 0 20px rgba(127,231,255,0.35); font-family: var(--mono); line-height: 1;
}
.tc-calc-sub { font-size: 12px; color: var(--muted); margin: 6px 0 16px; text-transform: uppercase; letter-spacing: 0.08em; }
.tc-calc-formula {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; font-size: 13px;
  color: var(--muted); background: rgba(0,0,0,0.3); border: 1px solid var(--border);
  padding: 12px 14px; border-radius: 8px; margin-bottom: 16px;
}
.tc-calc-op { color: var(--amber); }
.tc-calc-result { color: var(--text); font-weight: 600; }
.tc-insight {
  font-size: 13px; line-height: 1.6; color: var(--text); background: rgba(255,182,39,0.06);
  border-left: 2px solid var(--amber); padding: 12px 14px; border-radius: 4px;
}
.tc-insight strong { color: var(--amber); }

.tc-footer { text-align: center; font-size: 11px; color: var(--muted); margin-top: 32px; letter-spacing: 0.03em; }

@keyframes tc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes tc-blink { 50% { opacity: 0; } }
@keyframes tc-fadeup { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 600px) {
  .tc-container { padding: 20px 16px; }
  .tc-readout { font-size: 26px; }
  .tc-monitor-body { min-height: 200px; font-size: 14px; }
}
`;
