import { env } from '~/config/environment'
import ApiError from '~/utils/ApiError'
import { StatusCodes } from 'http-status-codes'

// Danh sách các model theo thứ tự ưu tiên:
// 1. gemini-2.5-flash-lite: Tốc độ phản hồi cực nhanh (~1.2s), hạ tầng nhẹ, ít bị nghẽn tải cao (high demand)
// 2. gemini-2.5-flash: Model cân bằng chất lượng & tốc độ
// 3. gemini-flash-lite-latest: Pool dự phòng cho flash-lite
// 4. gemini-3.5-flash: Model thế hệ tiếp theo
const CANDIDATE_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash'
]
const PER_MODEL_TIMEOUT_MS = 14000

const generateBoardFromPrompt = async (prompt, customApiKey = '') => {
  const apiKey = (customApiKey || env.GEMINI_API_KEY || '').trim()

  if (!apiKey) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Chưa cấu hình GEMINI_API_KEY. Vui lòng thêm GEMINI_API_KEY vào .env hoặc cung cấp API Key cá nhân.'
    )
  }

  const systemInstruction = `You are an expert Agile & Kanban Project Manager.
Given a user request, generate a structured, comprehensive Kanban board.
Rules:
1. "title": descriptive board title (3 to 50 characters).
2. "columns": an array of 3 to 5 logical workflow columns (e.g. "To do", "In progress", "Review", "Done", or stage-based columns suitable for the domain).
3. "cards": for each column, create 2 to 4 actionable task cards.
   - "title": clear action-oriented task title (3 to 60 characters).
   - "description": clear explanation or instructions (can be empty string or brief markdown).
   - "labels": array of 1 to 2 label objects with "color" (hex color e.g. "#0052cc", "#e11d48", "#16a34a", "#d97706", "#7c3aed") and optional "title" (e.g. "Frontend", "Backend", "High Priority", "Research").
   - "checklists": optional array of checklist objects, each with "title" (e.g. "Checklist") and "items" (array of { "title": "step description" }).
Respond in the language of the prompt (if Vietnamese, use Vietnamese; if English, use English).`

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${systemInstruction}\n\nUser request: ${prompt}` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.7
    }
  }

  let lastError = null

  for (const model of CANDIDATE_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS)
      })

      const data = await response.json()

      // Bất kỳ lỗi nào (503 High Demand, 429 Rate Limit, 404 Not Found, 500...),
      // ghi nhận và tự động fallback sang model tiếp theo trong danh sách
      if (!response.ok) {
        const errorMsg = data?.error?.message || response.statusText || 'Lỗi khi gọi Gemini API'
        lastError = new ApiError(response.status || StatusCodes.INTERNAL_SERVER_ERROR, errorMsg)
        continue
      }

      const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!textContent) {
        lastError = new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Gemini không trả về nội dung hợp lệ.')
        continue
      }

      const parsedBoard = JSON.parse(textContent)
      if (!parsedBoard.title || !Array.isArray(parsedBoard.columns)) {
        lastError = new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, 'Dữ liệu AI sinh ra không đúng cấu trúc bảng Kanban.')
        continue
      }

      // Đảm bảo độ dài title không vượt quá 50 ký tự
      if (parsedBoard.title.length > 50) {
        parsedBoard.title = parsedBoard.title.substring(0, 50).trim()
      }

      return parsedBoard
    } catch (error) {
      // Khi model bị timeout hoặc network error, tiếp tục thử model tiếp theo
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(
    StatusCodes.SERVICE_UNAVAILABLE,
    lastError?.message || 'Hệ thống AI tạm thời bận hoặc gặp sự cố kết nối. Vui lòng thử lại sau giây lát.'
  )
}

export const geminiProvider = {
  generateBoardFromPrompt
}
