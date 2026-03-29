// build trigger
// api/rpc.js
export async function callGAS(data) {
  // 본인의 구글 앱스 스크립트 웹앱 URL을 입력하세요
  const GAS_URL = "https://script.google.com/macros/s/AKfycbzRd9z8GR0LuLg8m-R7hq48shxSHIUJMRPr77ljhXtZ6Skhon6FyjrSO19qxwBoQSo/exec"; 
  
  const response = await fetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return await response.json();
}