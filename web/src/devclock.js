// Dev only (localhost): a fake "now" from localStorage 'haluach.fakeNow' (an ISO time), to check the board at other
// times (erev shabbat, yom tov, the omer). The clock runs on from that moment. Imported first by app.js.
const fake = location.hostname === 'localhost' && localStorage.getItem('haluach.fakeNow');
if (fake && !isNaN(Date.parse(fake))) {
  const Real = Date, shift = Real.parse(fake) - Real.now();
  globalThis.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); }
    static now() { return Real.now() + shift; }
  };
}
