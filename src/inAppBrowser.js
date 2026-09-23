// KakaoTalk opens shared links in its own in-app browser. On the customer's
// iPhone that browser dropped this site's storage between sessions (profile,
// order key and all), which silently undid every reconnection. It identifies
// itself in the user agent.
export function isKakaoInAppBrowser(userAgent = globalThis.navigator?.userAgent || '') {
  return /KAKAOTALK/i.test(String(userAgent));
}
