// The opening animation's boot script (TASK-0628), kept apart from the component so it can be tested without a bundler.
/** Set once the animation has played in this browser. */
export const SEEN_KEY = "amp-intro";

// Runs in <head>, before anything is painted. Only the home page, a browser that has not seen it, motion allowed,
// and not an automated client (crawlers, link previews, headless browsers: they should see the page itself).
export const INTRO_BOOT_SCRIPT = `(function(){try{var p=location.pathname.replace(/^\\/en(?=\\/|$)/,'')||'/';if(p!=='/')return;if(localStorage.getItem('${SEEN_KEY}'))return;if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;if(navigator.webdriver||/bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed/i.test(navigator.userAgent))return;window.__ampIntro=1;var r=document.documentElement;r.classList.add('intro');setTimeout(function(){r.classList.remove('intro','intro-out')},5600)}catch(e){}})();`;
