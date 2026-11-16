import { env } from '~/config/environment'
import ApiError from '~/utils/ApiError'
import { StatusCodes } from 'http-status-codes'

// Danh sách các model theo thứ tự ưu tiên (hỗ trợ tự động fallback khi Google cập nhật phiên bản)
const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
]
const REQUEST_TIMEOUT_MS = 30000

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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      const data = await response.json()

      if (!response.ok) {
        const errorMsg = data?.error?.message || response.statusText || 'Lỗi khi gọi Gemini API'
        // Nếu lỗi 404 (model not found / deprecated), thử model tiếp theo trong danh sách candidate
        if (response.status === 404 || errorMsg.includes('not found') || errorMsg.includes('not supported')) {
          lastError = new ApiError(response.status, errorMsg)
          continue
        }
        throw new ApiError(response.status || StatusCodes.INTERNAL_SERVER_ERROR, errorMsg)
      }

      const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!textContent) {
        lastError = new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, 'Gemini không trả về nội dung hợp lệ.')
        continue
      }

      const parsedBoard = JSON.parse(textContent)
      if (!parsedBoard.title || !Array.isArray(parsedBoard.columns)) {
        throw new ApiError(StatusCodes.UNPROCESSABLE_ENTITY, 'Dữ liệu AI sinh ra không đúng cấu trúc bảng Kanban.')
      }

      // Đảm bảo độ dài title không vượt quá 50 ký tự
      if (parsedBoard.title.length > 50) {
        parsedBoard.title = parsedBoard.title.substring(0, 50).trim()
      }

      return parsedBoard
    } catch (error) {
      if (error instanceof ApiError && error.statusCode !== 404) {
        throw error
      }
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(StatusCodes.INTERNAL_SERVER_ERROR, lastError?.message || 'Không thể kết nối tới các model AI khả dụng.')
}

export const geminiProvider = {
  generateBoardFromPrompt
}
