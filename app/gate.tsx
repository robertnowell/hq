import "./front-door.css";

/**
 * The document door's frame: a page's shape, drawn and blurred, and one
 * modal over it. What goes in the modal is the caller's: the sign-in, the
 * not-shared words, whatever the moment needs. The shape is a drawing,
 * never the document, so it is the same for every page.
 */
export function Gate({ children }: { children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-page" aria-hidden="true">
        <div className="gate-sheet">
          <span className="gate-bar" style={{ width: "34%", height: 10 }} />
          <span className="gate-bar" style={{ width: "78%", height: 26, marginTop: 18 }} />
          <span className="gate-bar" style={{ width: "56%", height: 26 }} />
          <span className="gate-bar" style={{ width: "92%", marginTop: 26 }} />
          <span className="gate-bar" style={{ width: "88%" }} />
          <span className="gate-bar" style={{ width: "95%" }} />
          <span className="gate-bar" style={{ width: "61%" }} />
          <span className="gate-block" />
          <span className="gate-bar" style={{ width: "90%" }} />
          <span className="gate-bar" style={{ width: "84%" }} />
          <span className="gate-bar" style={{ width: "93%" }} />
          <span className="gate-bar" style={{ width: "47%" }} />
        </div>
      </div>
      <section className="gate-ask">
        <div className="gate-modal">{children}</div>
      </section>
    </main>
  );
}
