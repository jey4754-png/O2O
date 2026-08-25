import { writeFile } from 'node:fs/promises';

const BASE_URL = 'https://www.code.go.kr/stdcode';
const PROVINCES = [
  ['11', '서울특별시'],
  ['26', '부산광역시'],
  ['27', '대구광역시'],
  ['28', '인천광역시'],
  ['29', '광주광역시'],
  ['30', '대전광역시'],
  ['31', '울산광역시'],
  ['36', '세종특별자치시'],
  ['41', '경기도'],
  ['43', '충청북도'],
  ['44', '충청남도'],
  ['46', '전라남도'],
  ['47', '경상북도'],
  ['48', '경상남도'],
  ['50', '제주특별자치도'],
  ['51', '강원특별자치도'],
  ['52', '전북특별자치도'],
  ['12', '전남광주통합특별시'],
];

async function post(path, data) {
  const response = await fetch(`${BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams(data),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.text();
}

function parseList(html, variable) {
  const match = html.match(new RegExp(`${variable}\\s*=\\s*"([^"]*)"`));
  if (!match) throw new Error(`${variable} not found`);
  return match[1].split(',').filter(Boolean);
}

async function loadProvince([code, name]) {
  const districtHtml = await post('sggCodeIL.do', { sidoCd: code, searchOk: '0' });
  const districtNames = parseList(districtHtml, 'strSggNm');
  const districtCodes = parseList(districtHtml, 'strSggCd');
  const districts = [];

  for (let index = 0; index < districtNames.length; index += 1) {
    const districtCode = districtCodes[index];
    const neighborhoodHtml = await post('umdCodeIL.do', {
      sidoCd: code,
      sggCd: districtCode,
      searchOk: '0',
    });
    const neighborhoods = parseList(neighborhoodHtml, 'umdNm');
    if (!neighborhoods.length) continue;
    districts.push({
      code: districtCode,
      name: districtNames[index],
      neighborhoods,
    });
  }

  return { code, name, districts };
}

const regions = [];
for (const province of PROVINCES) {
  const region = await loadProvince(province);
  regions.push(region);
  process.stdout.write(`${region.name}: ${region.districts.length}\n`);
}

const source = [
  '// Generated from the official Administrative Standard Code Management System.',
  '// Source: https://www.code.go.kr/stdcode/regCodeL.do',
  `// Generated: ${new Date().toISOString()}`,
  `export const REGIONS = ${JSON.stringify(regions, null, 2)};`,
  '',
].join('\n');

await writeFile(new URL('../src/regions.js', import.meta.url), source);
