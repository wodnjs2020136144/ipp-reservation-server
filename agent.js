// agent.js — Gemini API 기반의 AI 예약 비서 에이전트 모듈
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const crawler = require('./crawler');
const { nowKST } = require('./time');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// API 키가 없을 때의 폴백 응답 설정
const hasApiKey = !!GEMINI_API_KEY;
const genAI = hasApiKey ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// AI가 호출할 수 있는 로컬 도구(Tool) 정의
const getReservationsTool = {
  name: 'getReservations',
  description: '특정 분야의 오늘 예약 현황 목록을 가져옵니다. 분야 종류: ai(인공지능로봇배움터), earthquake(지진VR), drone(드론VR), science(기초과학해설), toddler(유아과학관 자유체험), robot(로봇댄스)',
  parameters: {
    type: 'OBJECT',
    properties: {
      type: {
        type: 'STRING',
        description: '조회할 분야 ID (ai, earthquake, drone, science, toddler, robot)'
      }
    },
    required: ['type']
  }
};

const getAllReservationsTool = {
  name: 'getAllReservations',
  description: '모든 예약 카테고리(ai, earthquake, drone, science, toddler, robot)의 오늘 날짜 현황을 모두 가져옵니다.',
  parameters: {
    type: 'OBJECT',
    properties: {}
  }
};

// 도구 실행 맵러
const functions = {
  getReservations: ({ type }) => {
    const today = nowKST().format('YYYY-MM-DD');
    let data = db.getReservations(type, today);
    if (!data || data.length === 0) {
      // 캐시가 비어있으면 백필
      return crawler.crawlAndSave(type)
        .then(() => db.getReservations(type, today))
        .catch(() => []);
    }
    return data;
  },
  getAllReservations: async () => {
    const today = nowKST().format('YYYY-MM-DD');
    let data = db.getReservationsAll(today);
    const ippEmpty = Object.values(data.ipp).every(arr => arr.length === 0);
    const commentatorEmpty = Object.values(data.commentator).every(arr => arr.length === 0);

    if (ippEmpty && commentatorEmpty) {
      await crawler.crawlAll();
      data = db.getReservationsAll(today);
    }
    return data;
  }
};

/**
 * 사용자의 자연어 메시지를 입력받아 AI Agent 루프를 실행하고 답변을 반환합니다.
 * @param {string} userMessage - 사용자가 보낸 자연어 질문
 * @returns {Promise<string>} AI의 최종 응답 메시지
 */
async function handleAgentChat(userMessage) {
  if (!hasApiKey) {
    return '현재 서버에 GEMINI_API_KEY 환경변수가 설정되지 않아 데모 모드로 작동 중입니다. 과학관 예약 관련 질문(예: "오늘 지진 VR 예약 남았어?")에 답변하기 위해 API 키 등록이 필요합니다. \n\n[개발 안내] 서버 폴더 루트에 .env 파일을 만들고 GEMINI_API_KEY=your_key 를 입력해주세요.';
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: `당신은 충청남도교육청 과학교육원의 체험/가이드 예약을 지원하는 AI 예약 비서 에이전트입니다.
      - 오늘 날짜는 ${nowKST().format('YYYY년 MM월 DD일')} 이며 요일은 ${['일', '월', '화', '수', '목', '금', '토'][nowKST().day()]}요일입니다.
      - 사용자의 질문에서 예약 관련 정보를 가져와야 하는 경우, 반드시 적절한 도구(getReservations 또는 getAllReservations)를 호출하십시오.
      - 도구를 실행해 얻은 JSON 응답을 분석하여 친절하고 가독성 좋은 한국어 자연어로 답하십시오.
      - 마감된 회차에 대해서는 잔여석을 '마감됨'으로 안내하되, 융통성 있게 답하세요.
      - 시간 체크 및 휴무일 조건: 매주 월요일은 휴관이며, 지진 VR의 경우 일요일에는 운영되지 않습니다.`,
      tools: [{ functionDeclarations: [getReservationsTool, getAllReservationsTool] }]
    });

    const chat = model.startChat();
    let result = await chat.sendMessage(userMessage);
    const response = result.response;

    // 도구 호출(Function Calling)이 발생했는지 확인
    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      const fnName = call.name;
      const fnArgs = call.args;

      console.log(`[AI Agent Tool Call] Triggered: ${fnName} with args:`, fnArgs);

      // 도구 실행
      const executor = functions[fnName];
      let fnResult;
      if (executor) {
        fnResult = await executor(fnArgs);
      } else {
        fnResult = { error: 'Function not found' };
      }

      // 도구 실행 결과를 다시 LLM에게 전달하여 최종 답변 완성
      const secondResult = await chat.sendMessage([{
        functionResponse: {
          name: fnName,
          response: { content: fnResult }
        }
      }]);

      return secondResult.response.text();
    }

    return response.text();
  } catch (error) {
    console.error('[AI Agent Error]', error);
    return 'AI 예약 비서 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
  }
}

module.exports = {
  handleAgentChat
};
