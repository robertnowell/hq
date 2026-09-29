/* Inside the gate's own card: no second frame, and only the email field.
   The other ways in (Apple, Google, a phone, a passkey) exist on the front
   door; the person at this door was told to enter an email, so that is all
   there is.

   overflow is visible on purpose. Clerk's cardBox clips, and with the card's
   padding gone the input's outline (a 1px box-shadow) and the tops of the
   code boxes sat exactly on the clip line (Robert, 27 Sep, two screenshots). */
export const gateCard = {
  elements: {
    rootBox: { width: "100%" },
    cardBox: { width: "100%", boxShadow: "none", border: "none", borderRadius: 0, overflow: "visible" },
    card: { padding: "2px", boxShadow: "none", border: "none", background: "transparent", overflow: "visible" },
    header: { display: "none" },
    footer: { display: "none" },
    footerAction: { display: "none" },
    socialButtons: { display: "none" },
    socialButtonsRoot: { display: "none" },
    dividerRow: { display: "none" },
    formFieldAction: { display: "none" },
  },
};
