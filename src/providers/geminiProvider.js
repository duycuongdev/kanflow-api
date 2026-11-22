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

const chatWithCopilot = async ({
  message,
  history = [],
  boardContext = null,
  language = 'vi',
  customApiKey = '',
  attachments = [],
  localNowISO = null
}) => {
  const apiKey = (customApiKey || env.GEMINI_API_KEY || '').trim()

  if (!apiKey) {
    throw new ApiError(
      StatusCodes.BAD_REQUEST,
      'Chưa cấu hình GEMINI_API_KEY. Vui lòng thêm GEMINI_API_KEY vào .env hoặc cung cấp API Key cá nhân.'
    )
  }

  const langDirective = language === 'vi'
    ? 'The user interface is in Vietnamese. Default your response message and any generated board/column/card titles and descriptions to Vietnamese, unless the user specifically asks in English or another language.'
    : 'The user interface is in English. Default your response message and any generated board/column/card titles and descriptions to English, unless the user specifically asks in another language.'

  let boardContextText = ''
  if (boardContext && boardContext.title) {
    const colsSummary = (boardContext.columns || []).map(col => {
      const cardsList = (col.cards || []).slice(0, 10).map(card => card.title).join(', ')
      return `Column "${col.title}" (id: "${col._id}"): [${cardsList || 'No cards'}]`
    }).join('\n')

    boardContextText = `
CURRENT ACTIVE BOARD:
- Board ID: "${boardContext._id}"
- Board Title: "${boardContext.title}"
- Description: "${boardContext.description || 'None'}"
- Columns & Tasks:
${colsSummary || 'No columns'}
`
  }

  const nowContextText = localNowISO
    ? `CURRENT USER LOCAL DATE/TIME: ${localNowISO}
Use this as the reference "now" to resolve relative dates in the user's request (e.g. "ngày mai" = tomorrow, "tuần sau" = next week, "9h" = 09:00 local time). Always output schedule dates in ISO 8601 WITH the user's UTC offset (e.g. "2026-11-23T09:00:00+07:00").
`
    : ''

  const systemInstruction = `You are Kanflow Assistant, an intelligent AI Assistant and Project Manager built into Kanflow (a real-time Kanban & Agile collaboration platform).
Your mission is to help users manage their workspaces, design boards, plan agile workflows, add cards, suggest tasks, summarize progress, and answer productivity questions.

Language Guidelines:
${langDirective}

Multimodal & Image Guidelines:
Users can attach or paste images (screenshots, wireframes, diagrams, bug reports). If the user provides an image or attachment, inspect it thoroughly to answer questions, analyze workflows, describe tasks, or suggest boards/columns/cards.

Capabilities & Actions:
1. "CREATE_BOARD": When user asks to generate, create, or plan a new board/project/workflow.
   payload: {
     "title": "descriptive board title (max 50 chars)",
     "description": "brief board description",
     "columns": [
       {
         "title": "Column title",
         "cards": [
           {
             "title": "Task title (max 60 chars)",
             "description": "Clear explanation or instructions in markdown",
             "labels": [{ "title": "Tag name", "color": "#hex" }],
             "checklists": [{ "title": "Checklist", "items": [{ "title": "Subtask", "isDone": false }] }]
           }
         ]
       }
     ]
   }
2. "CREATE_COLUMN": When user asks to add a column/stage/list to the current active board (ONLY if CURRENT ACTIVE BOARD is present).
   payload: {
     "boardId": "${boardContext?._id || ''}",
     "title": "Column title"
   }
3. "CREATE_CARD": When user asks to create or add a card/task to the current active board (ONLY if CURRENT ACTIVE BOARD is present).
   payload: {
     "boardId": "${boardContext?._id || ''}",
     "columnId": "matching column _id from current active board, or leave empty/null if user didn't specify",
     "title": "Task title",
     "description": "Task description in markdown",
     "labels": [{ "title": "Tag name", "color": "#hex" }],
     "checklists": [{ "title": "Checklist", "items": [{ "title": "Subtask", "isDone": false }] }]
   }
4. "CREATE_SCHEDULE": When user asks to schedule / plan a personal calendar entry (lịch cá nhân), e.g. "cho học React vào ngày mai 9h-11h", "nhắc họp team thứ 3 tuần sau 14h", "đặt lịch ôn tập tối nay".
   payload: {
     "title": "short schedule title (max 120 chars)",
     "startAtISO": "ISO 8601 datetime WITH UTC offset, e.g. '2026-11-23T09:00:00+07:00'",
     "endAtISO": "ISO 8601 datetime WITH UTC offset, must be after startAtISO, max 24h duration",
     "colorKey": "one of: blue | orange | green | purple | red | pink (pick a sensible one)",
     "description": "optional short note (max 2000 chars)"
   }
5. "UPDATE_CARD_DUE_DATE": When user asks to set/change deadlines (due dates, hạn chót) on EXISTING cards. ONLY cards from the CURRENT ACTIVE BOARD can be updated (if CURRENT ACTIVE BOARD is missing, respond with action null and explain they need to open a board first). Copy card titles EXACTLY as they appear in the board context. If the user gives a date range (e.g. "from tomorrow to 28/11") for multiple cards, SPREAD the deadlines evenly across the requested cards in order.
   payload: {
     "updates": [
       { "title": "exact card title from board context", "dueDateISO": "ISO 8601 datetime WITH UTC offset, e.g. '2026-11-23T18:00:00+07:00'" }
     ]
   }
6. "UPDATE_COLUMN_TITLE": Rename a column of the CURRENT ACTIVE BOARD.
   payload: { "columnTitle": "current column title from board context", "newTitle": "new title" }
7. "ARCHIVE_COLUMN": Archive (hide) a column of the CURRENT ACTIVE BOARD - reversible, nothing is deleted.
   payload: { "columnTitle": "column title to archive" }
8. "RESTORE_COLUMN": Restore a previously archived column of the CURRENT ACTIVE BOARD.
   payload: { "columnTitle": "archived column title to restore" }
9. "UPDATE_CARD": Update the title and/or description of an EXISTING card of the CURRENT ACTIVE BOARD. Copy the card title EXACTLY from board context. Include ONLY the fields the user wants changed.
   payload: { "cardTitle": "current card title from board context", "newTitle": "optional new title", "newDescription": "optional new description" }
10. "ARCHIVE_CARD": Archive (hide) a card of the CURRENT ACTIVE BOARD - reversible, nothing is deleted.
   payload: { "cardTitle": "card title to archive" }
11. "RESTORE_CARD": Restore a previously archived card of the CURRENT ACTIVE BOARD.
   payload: { "cardTitle": "archived card title to restore" }
12. "INVITE_MEMBER": Invite a person to a board by email. Defaults to the CURRENT ACTIVE BOARD, or the board the user names from USER BOARDS.
   payload: { "inviteeEmail": "the email address to invite", "boardTitle": "optional board title from USER BOARDS" }
13. "CLOSE_BOARD": Close (archive) a board - it can be reopened later, nothing is deleted.
   payload: { "boardTitle": "optional board title from USER BOARDS; defaults to CURRENT ACTIVE BOARD" }
14. "REOPEN_BOARD": Reopen a closed board.
   payload: { "boardTitle": "board title from USER BOARDS" }
15. General Conversation / Advice / Task Breakdown / Summary:
   When user asks a question, requests advice, says hi, or wants a summary.
   "action": null, "payload": null.

Output Rules:
You MUST ALWAYS respond with valid JSON matching this schema:
{
  "message": "Friendly, helpful markdown response to display to the user in chat",
  "action": null | "CREATE_BOARD" | "CREATE_COLUMN" | "CREATE_CARD" | "CREATE_SCHEDULE" | "UPDATE_CARD_DUE_DATE" | "UPDATE_COLUMN_TITLE" | "ARCHIVE_COLUMN" | "RESTORE_COLUMN" | "UPDATE_CARD" | "ARCHIVE_CARD" | "RESTORE_CARD" | "INVITE_MEMBER" | "CLOSE_BOARD" | "REOPEN_BOARD",
  "payload": null | object
}`

  const contents = []

  if (Array.isArray(history) && history.length > 0) {
    const recentHistory = history.slice(-6)
    for (const h of recentHistory) {
      if (h.role && h.content) {
        contents.push({
          role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
          parts: [{ text: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }]
        })
      }
    }
  }

  const currentTurnText = `${systemInstruction}\n${nowContextText}${boardContextText}\nUser Message: ${message}`
  const userParts = [{ text: currentTurnText }]

  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (att?.mimeType && att?.base64) {
        userParts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.base64
          }
        })
      }
    }
  }

  contents.push({
    role: 'user',
    parts: userParts
  })

  const requestBody = {
    contents,
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

      const parsedResult = JSON.parse(textContent)
      if (!parsedResult.message) {
        parsedResult.message = language === 'vi'
          ? 'Tôi đã tiếp nhận yêu cầu của bạn.'
          : 'I have received your request.'
      }

      return parsedResult
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(
    StatusCodes.SERVICE_UNAVAILABLE,
    lastError?.message || 'Kanflow Assistant tạm thời bận hoặc gặp sự cố kết nối. Vui lòng thử lại sau giây lát.'
  )
}

export const geminiProvider = {
  generateBoardFromPrompt,
  chatWithCopilot
}
