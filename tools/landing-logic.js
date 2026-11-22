class Component extends DCLogic {
constructor(props) {
super(props);
var unlocked = false;
try { unlocked = window.localStorage.getItem('arc_report_unlocked') === '1'; } catch (err) {}
this.run = 0;
this.state = { url: '', phase: 'idle', step: 0, report: null, error: '', email: '', subscribed: false, car: 0, wrapIdx: -1, issuesOpen: false, unlocked: unlocked, gateEmail: '', gateBusy: false, gateError: '' };
}
componentDidMount() {
var self = this;
}
componentWillUnmount() {
if (this.timer) clearInterval(this.timer);
if (this.wrapT) clearTimeout(this.wrapT);
if (this.snapT) clearTimeout(this.snapT);
}
domainOf(raw) {
var d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
return d || 'votre-boutique.com';
}
start() {
var self = this;
if (this.state.phase === 'scanning') return;
var raw = String(this.state.url || '').trim();
if (!raw) { var el = this.urlInput; if (el && el.focus) el.focus(); return; }
var domain = this.domainOf(raw);
if (this.timer) clearInterval(this.timer);
var run = ++this.run;
var result = null;
var failure = '';
var stepsDone = false;
var finish = function () {
if (run !== self.run || !stepsDone) return;
if (failure) self.setState({ phase: 'error', error: failure, report: null });
else if (result) self.setState({ phase: 'done', report: result, issuesOpen: self.state.unlocked });
};
this.setState({ phase: 'scanning', step: 0, report: null, error: '', domain: domain, issuesOpen: false, gateError: '' });
if (this.urlInput && this.urlInput.blur) this.urlInput.blur();
setTimeout(function () { var a = self.auditAnchor; if (a && a.scrollIntoView) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 80);
fetch('/api/audit?url=' + encodeURIComponent(raw), { headers: { accept: 'application/json' } })
.then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
.then(function (x) {
if (!x.ok || !x.j || x.j.error) failure = (x.j && x.j.message) || 'L’analyse a échoué. Réessayez dans un instant.';
else result = x.j;
finish();
}, function () { failure = 'Connexion impossible. Vérifiez votre réseau et réessayez.'; finish(); });
this.timer = setInterval(function () {
if (run !== self.run) { clearInterval(self.timer); self.timer = null; return; }
var next = self.state.step + 1;
if (next < 5) { self.setState({ step: next }); return; }
if (!result && !failure) return;
clearInterval(self.timer);
self.timer = null;
self.setState({ step: 5 });
setTimeout(function () { stepsDone = true; finish(); }, 450);
}, 2200);
}
submitGate() {
var self = this;
var st = this.state;
var email = String(st.gateEmail || '').trim();
if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { this.setState({ gateError: 'Indiquez une adresse e-mail valide.' }); return; }
if (st.gateBusy) return;
this.setState({ gateBusy: true, gateError: '' });
var r = st.report || {};
fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, domain: r.domain, score: r.score }) })
.then(function (res) {
if (!res.ok) return res.json().then(function (j) { throw new Error((j && j.message) || 'Envoi impossible, réessayez.'); }, function () { throw new Error('Envoi impossible, réessayez.'); });
try { window.localStorage.setItem('arc_report_unlocked', '1'); } catch (err) {}
self.setState({ gateBusy: false, unlocked: true, issuesOpen: true });
})
.catch(function (err) { self.setState({ gateBusy: false, gateError: (err && err.message) || 'Envoi impossible, réessayez.' }); });
}
slideRefFor(i) {
var self = this;
if (!this._slideRefs) this._slideRefs = [];
if (!this._slideRefs[i]) this._slideRefs[i] = function (el) { if (!self.slides) self.slides = []; self.slides[i] = el; };
return this._slideRefs[i];
}
goTo(i) {
var self = this;
var t = this.track;
var el = this.slides && this.slides[i];
var prev = this.state.car;
var wrap = -1;
for (var k = 0; k < 3; k++) { if (Math.abs(this.relOf(k, i) - this.relOf(k, prev)) === 2) wrap = k; }
this.setState({ car: i, wrapIdx: wrap });
if (this.wrapT) clearTimeout(this.wrapT);
if (wrap >= 0) this.wrapT = setTimeout(function () { self.setState({ wrapIdx: -1 }); }, 820);
if (!t) return;
try { if (window.innerWidth >= 900) return; } catch (err) {}
var left;
if (el) { left = el.offsetLeft - (t.clientWidth - el.offsetWidth) / 2; }
else { left = (t.scrollWidth - t.clientWidth) * i / 2; }
left = Math.max(0, Math.min(left, t.scrollWidth - t.clientWidth));
t.style.scrollSnapType = 'none';
t.scrollTo({ left: left, behavior: 'smooth' });
if (this.snapT) clearTimeout(this.snapT);
this.snapT = setTimeout(function () { t.style.scrollSnapType = 'x mandatory'; }, 700);
}
relOf(i, car) {
return ((i - car + 4) % 3) - 1;
}
slideCls(i, car, wrapIdx) {
var off = this.relOf(i, car) - (i - 1);
var name = (off < 0 ? 'm' : 'p') + Math.abs(off);
return (i === car ? 'is-active' : 'is-side') + ' off-' + name + (i === wrapIdx ? ' is-wrap' : '');
}
renderVals() {
var self = this;
var st = this.state;
var labels = ['Lecture du catalogue', 'Analyse des attributs produits', 'Vérification des données structurées', 'Test de compatibilité UCP / ACP / MCP', 'Vérification du parcours d’achat par un agent'];
var checks = labels.map(function (l, i) {
var done = i < st.step, active = i === st.step;
return { label: l + (active ? '…' : ''), done: done, active: active, pending: !done && !active, color: done || active ? '#F5F5F7' : '#6E6E73' };
});
var r = st.report;
var rest = r ? r.issues.slice(1) : [];
var analyzedOn = '';
if (r && r.analyzedAt) { try { analyzedOn = new Date(r.analyzedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (err) {} }
return {
accent: this.props.accent ?? '#2B50E6',
url: st.url,
onUrl: function (e) { self.setState({ url: e.target.value }); },
onSubmit: function (e) { if (e && e.preventDefault) e.preventDefault(); self.start(); },
reset: function () { self.run++; if (self.timer) clearInterval(self.timer); self.timer = null; self.setState({ phase: 'idle', step: 0, report: null, error: '', url: '' }); setTimeout(function () { var el = self.urlInput; if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60); },
idle: st.phase === 'idle',
scanning: st.phase === 'scanning',
done: st.phase === 'done' && !!r,
failed: st.phase === 'error',
errorMsg: st.error,
domain: r ? r.domain : (st.domain || this.domainOf(st.url)),
progress: Math.round(st.step / 5 * 100),
checks: checks,
score: r ? r.score : 0,
scoreDeg: r ? Math.round(r.score * 3.6) : 0,
verdictColor: r ? r.color : '#FF453A',
verdictTag: r ? r.verdict.tag : '',
verdictTitle: r ? r.verdict.title : '',
verdictText: r ? r.verdict.text : '',
subs: r ? r.subs : [],
issues: r ? r.issues : [],
issuesFirst: r ? r.issues.slice(0, 1) : [],
issuesRest: rest,
hasMoreIssues: rest.length > 0,
showToggle: rest.length > 0 && st.unlocked,
locked: rest.length > 0 && !st.unlocked,
gateTitle: 'Débloquez les ' + rest.length + ' autres points d’amélioration',
gateEmail: st.gateEmail,
onGateEmail: function (e) { self.setState({ gateEmail: e.target.value, gateError: '' }); },
onGateSubmit: function (e) { if (e && e.preventDefault) e.preventDefault(); self.submitGate(); },
gateBusy: st.gateBusy,
gateCta: st.gateBusy ? 'Envoi…' : 'Voir le rapport complet',
hasGateError: !!st.gateError,
gateError: st.gateError,
issuesOpen: !!st.issuesOpen && st.unlocked,
issuesSign: st.issuesOpen ? '−' : '+',
issuesToggleLabel: st.issuesOpen ? 'Masquer les autres points' : ('Voir les ' + rest.length + ' autres points d’amélioration'),
toggleIssues: function () { self.setState({ issuesOpen: !self.state.issuesOpen }); },
total: r ? r.total : 0,
totalLabel: r ? r.totalLabel : '',
footnote: r ? ('Analyse automatique des pages publiques' + (analyzedOn ? ' du ' + analyzedOn : '') + ' · ' + r.platformLabel + ' · Score indicatif, à confirmer par un audit complet.') : '',
potential: r ? r.potential : 0,
trackRef: function (el) { self.track = el; },
goResult: function () { self.goTo(1); },
goSolution: function () { self.goTo(2); },
railCls: '',
slideCls0: this.slideCls(0, st.car, st.wrapIdx),
slideCls1: this.slideCls(1, st.car, st.wrapIdx),
slideCls2: this.slideCls(2, st.car, st.wrapIdx),
prevSlide: function () { if (self.state.car > 0) self.goTo(self.state.car - 1); },
nextSlide: function () { if (self.state.car < 2) self.goTo(self.state.car + 1); },
prevDisabled: st.car === 0,
nextDisabled: st.car === 2,
prevOpacity: st.car === 0 ? 0.3 : 1,
nextOpacity: st.car === 2 ? 0.3 : 1,
urlRef: function (el) { self.urlInput = el; },
auditAnchorRef: function (el) { self.auditAnchor = el; },
goAudit: function () { var el = self.urlInput; if (!el) return; if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { try { el.focus({ preventScroll: true }); } catch (err) {} }, 500); },
slideRef0: this.slideRefFor(0),
slideRef1: this.slideRefFor(1),
slideRef2: this.slideRefFor(2),
onTrackScroll: function (e) { var t = e.currentTarget; var max = t.scrollWidth - t.clientWidth; if (max <= 4) return; var i = Math.round(t.scrollLeft / max * 2); if (i !== self.state.car) self.setState({ car: i }); },
dots: [0, 1, 2].map(function (i) { return { label: ['Voir l’analyse en cours', 'Voir le rapport d’audit', 'Voir notre solution'][i], w: st.car === i ? 24 : 8, bg: st.car === i ? '#F5F5F7' : '#48484A', go: function () { self.goTo(i); } }; }),
email: st.email,
onEmail: function (e) { self.setState({ email: e.target.value }); },
onSubscribe: function (e) { if (e && e.preventDefault) e.preventDefault(); if (String(st.email || '').indexOf('@') > 0) self.setState({ subscribed: true }); },
nlForm: !st.subscribed,
subscribed: st.subscribed,
emailShown: st.email
};
}
}
