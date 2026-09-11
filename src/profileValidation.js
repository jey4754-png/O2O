const KOREAN_MOBILE_PHONE_PATTERN = /^010\d{8}$/;

export const KOREAN_MOBILE_PHONE_ERROR = '010으로 시작하는 휴대폰 번호 11자리를 입력해 주세요.';

export function normalizeKoreanMobilePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isValidKoreanMobilePhone(value) {
  return KOREAN_MOBILE_PHONE_PATTERN.test(normalizeKoreanMobilePhone(value));
}

export function callableKoreanMobilePhone(value) {
  const phone = normalizeKoreanMobilePhone(value);
  return isValidKoreanMobilePhone(phone) ? phone : '';
}

export function formatKoreanMobilePhoneInput(value) {
  const phone = normalizeKoreanMobilePhone(value).slice(0, 20);
  if (phone.length <= 3) return phone;
  if (phone.length <= 7) return `${phone.slice(0, 3)}-${phone.slice(3)}`;
  return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
}
