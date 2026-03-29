/**
 * [The Oreum Attendance System - API Bridge]
 * 구글 앱스 스크립트(GAS)와 통신하는 핵심 모듈입니다.
 */

export async function callGAS(data) {
  // 본인의 구글 앱스 스크립트 웹앱 URL (배포 시 받은 URL)
  const GAS_URL = "https://script.google.com/macros/s/AKfycbzRd9z8GR0LuLg8m-R7hq48shxSHIUJMRPr77ljhXtZ6Skhon6FyjrSO19qxwBoQSo/exec"; 
  
  try {
    const response = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify(data)
    });

    if (!response.ok) throw new Error('Network response was not ok');
    
    return await response.json();
  } catch (error) {
    console.error('[API Error]:', error);
    return { success: false, message: '서버 통신 중 오류가 발생했습니다.' };
  }
}