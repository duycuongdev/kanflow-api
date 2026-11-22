import { geminiProvider } from '~/providers/geminiProvider'
import { boardService } from '~/services/boardService'
import { columnService } from '~/services/columnService'
import { cardService } from '~/services/cardService'
import { scheduleService } from '~/services/scheduleService'

// Format epoch ms theo múi giờ của user (offset lấy từ localNowISO client gửi lên, vd '+07:00')
const dayjsFmt = (epochMs, offsetMinutes = 0) => {
  const d = new Date(epochMs + offsetMinutes * 60000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// Đọc offset phút từ chuỗi localNowISO (vd '2026-11-22T17:30:00+07:00' -> 420)
const tzOffsetMinutesFrom = (localNowISO) => {
  const m = String(localNowISO || '').match(/([+-])(\d{2}):?(\d{2})\s*$/)
  if (!m) return 0
  const value = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return m[1] === '-' ? -value : value
}

const chat = async (userId, { message, history = [], currentBoardId = null, language = 'vi', customApiKey = '', attachments = [], localNowISO = null }) => {
  let boardContext = null
  if (currentBoardId) {
    try {
      boardContext = await boardService.getDetails(userId, currentBoardId)
    } catch {
      boardContext = null
    }
  }

  const offsetMinutes = tzOffsetMinutesFrom(localNowISO)

  const aiResult = await geminiProvider.chatWithCopilot({
    message,
    history,
    boardContext,
    language,
    customApiKey,
    attachments,
    localNowISO
  })

  let actionResult = null

  if (aiResult.action === 'CREATE_BOARD' && aiResult.payload?.title) {
    try {
      const createdBoard = await boardService.importBoard(userId, aiResult.payload)
      actionResult = {
        type: 'BOARD_CREATED',
        data: createdBoard
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo bảng do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create board due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_COLUMN' && aiResult.payload?.title) {
    try {
      const targetBoardId = aiResult.payload.boardId || currentBoardId
      if (targetBoardId) {
        const createdColumn = await columnService.createNew(userId, {
          boardId: targetBoardId,
          title: aiResult.payload.title
        })
        actionResult = {
          type: 'COLUMN_CREATED',
          data: createdColumn
        }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo cột do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create column due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_CARD' && aiResult.payload?.title) {
    try {
      const targetBoardId = aiResult.payload.boardId || currentBoardId
      let targetColumnId = aiResult.payload.columnId

      // Nếu không có columnId hoặc columnId không tìm thấy, lấy cột đầu tiên của board hiện tại
      if ((!targetColumnId || targetColumnId === 'null') && boardContext?.columns?.length > 0) {
        targetColumnId = boardContext.columns[0]._id.toString()
      }

      if (targetBoardId && targetColumnId) {
        const createdCard = await cardService.createNew(userId, {
          boardId: targetBoardId,
          columnId: targetColumnId.toString(),
          title: aiResult.payload.title,
          description: aiResult.payload.description || '',
          labels: aiResult.payload.labels || [],
          checklists: aiResult.payload.checklists || []
        })
        actionResult = {
          type: 'CARD_CREATED',
          data: createdCard
        }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo thẻ do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create card due to: ${err.message})*`
    }
  } else if (aiResult.action === 'CREATE_SCHEDULE' && aiResult.payload?.title) {
    try {
      const startAt = Date.parse(aiResult.payload.startAtISO)
      const endAt = Date.parse(aiResult.payload.endAtISO)

      if (Number.isNaN(startAt) || Number.isNaN(endAt)) {
        throw new Error('Invalid schedule datetime (startAtISO/endAtISO)')
      }
      if (endAt <= startAt) {
        throw new Error('Schedule end time must be after start time')
      }

      const createdEntry = await scheduleService.createNewEntry({
        title: aiResult.payload.title,
        description: aiResult.payload.description || '',
        startAt,
        endAt,
        colorKey: aiResult.payload.colorKey
      }, userId)

      actionResult = {
        type: 'SCHEDULE_CREATED',
        data: createdEntry
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể tự động tạo lịch do: ${err.message})*`
        : `\n\n*(Note: Could not automatically create schedule due to: ${err.message})*`
    }
  } else if (aiResult.action === 'UPDATE_CARD_DUE_DATE' && Array.isArray(aiResult.payload?.updates) && aiResult.payload.updates.length > 0) {
    try {
      // Chỉ thao tác trên board đang mở: user phải là owner/member của board chứa card (cardService.update tự kiểm tra IDOR)
      if (!currentBoardId || !boardContext) {
        throw new Error(language === 'vi'
          ? 'Bạn cần mở một bảng trước khi đặt hạn chót cho card.'
          : 'Open a board first before setting card deadlines.')
      }

      // Gom card của board theo title (case-insensitive) từ boardContext
      const boardCards = (boardContext.columns || [])
        .flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title })))

      const updated = []
      const notFound = []
      const invalidDates = []

      for (const upd of aiResult.payload.updates) {
        const title = String(upd.title || '').trim()
        const dueDate = Date.parse(upd.dueDateISO)
        if (!title) continue
        if (Number.isNaN(dueDate)) {
          invalidDates.push(title)
          continue
        }
        const card = boardCards.find((c) => c.title.toLowerCase() === title.toLowerCase())
        if (!card) {
          notFound.push(title)
          continue
        }
        await cardService.update(card._id.toString(), { dueDate }, undefined, { _id: userId })
        updated.push({ title: card.title, dueDate, columnTitle: card.columnTitle })
      }

      let summary = language === 'vi'
        ? `\n\n📅 Đã đặt hạn chót cho ${updated.length} card: ${updated.map((u) => '"' + u.title + '" -> ' + dayjsFmt(u.dueDate, offsetMinutes)).join(', ')}`
        : `\n\n📅 Due dates set for ${updated.length} cards: ${updated.map((u) => '"' + u.title + '" -> ' + dayjsFmt(u.dueDate, offsetMinutes)).join(', ')}`
      if (notFound.length > 0) {
        summary += language === 'vi'
          ? '. Không tìm thấy: ' + notFound.join(', ')
          : '. Not found: ' + notFound.join(', ')
      }
      if (invalidDates.length > 0) {
        summary += language === 'vi'
          ? '. Ngày không hợp lệ: ' + invalidDates.join(', ')
          : '. Invalid dates: ' + invalidDates.join(', ')
      }
      aiResult.message += summary

      actionResult = {
        type: 'CARDS_DUE_DATE_UPDATED',
        data: { updatedCount: updated.length, updated, notFound, invalidDates }
      }
    } catch (err) {
      aiResult.message += language === 'vi'
        ? `\n\n*(Lưu ý: Không thể đặt hạn chót do: ${err.message})*`
        : `\n\n*(Note: Could not set due dates due to: ${err.message})*`
    }
  }

  return {
    message: aiResult.message,
    action: aiResult.action,
    actionResult
  }
}

export const aiService = {
  chat
}
