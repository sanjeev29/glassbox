import "./App.css";

function App() {
  return (
    <div className="popup">
      <header className="popup-header">
        <h1>Glassbox</h1>
        <span className="tagline">Your local AI bodyguard</span>
      </header>

      <section className="feature">
        <div className="feature-icon">H</div>
        <div>
          <h2>Humanity Score</h2>
          <p>
            Tracks how much of your text is typed vs. pasted. A score of
            <strong> 100%</strong> means fully hand-typed.
            Pasting content lowers the score proportionally.
          </p>
        </div>
      </section>

      <section className="feature">
        <div className="feature-icon warning">!</div>
        <div>
          <h2>PII Scrubber + Auto-Redact</h2>
          <p>
            Scans text areas in real time for 12 secret types: emails, phone
            numbers, AWS/Stripe/OpenAI/Anthropic/Google keys, GitHub tokens,
            Slack tokens, JWTs, private keys, and database URLs. Also detects
            invisible zero-width, bidi, and Unicode tag characters used in
            prompt-injection attacks. Click <strong>Redact</strong> in the
            panel to clean one detection at a time, or switch the panel mode
            to <strong>Redact</strong> (auto-clean on submit) or
            <strong> Block</strong> (prevent submission entirely).
          </p>
        </div>
      </section>

      <section className="feature">
        <div className="feature-icon canned">A</div>
        <div>
          <h2>Local AI Response Analyzer</h2>
          <p>
            When an AI chatbot responds, Glassbox runs a quantized DistilBERT
            sentiment classifier on your device (WebGPU with WASM fallback).
            No data leaves your browser. The result appears in the floating
            panel within ~50ms after the response finishes streaming.
          </p>
        </div>
      </section>

      <section className="feature">
        <div className="feature-icon sites">G</div>
        <div>
          <h2>Site Support</h2>
          <p>
            Purpose-built DOM adapters for <strong>ChatGPT</strong> and{" "}
            <strong>Claude.ai</strong> detect input fields and streaming
            responses automatically. On all other sites, Glassbox attaches to
            every <code>&lt;textarea&gt;</code>.
          </p>
        </div>
      </section>

      <footer className="popup-footer">
        <div className="footer-badge">
          <span className="lock">&#x1f512;</span> 100% local &mdash; no data leaves your browser
        </div>
        <p className="version">
          All inference runs on-device via WebGPU / WASM.
          <br />
          v1.0.0
        </p>
      </footer>
    </div>
  );
}

export default App;
