import { geminiProvider } from '~/providers/geminiProvider'
import { boardService } from '~/services/boardService'
import { cardService } from '~/services/cardService'
import { columnService } from '~/services/columnService'
import { invitationService } from '~/services/invitationService'
import { scheduleService } from '~/services/scheduleService'

// Format epoch ms theo múi giờ của user (offset lấy từ localNowISO client gửi lên, vd '+07:00')
const NEWLINE2 = '\n\n'

const noBoardMsg = (language) => language === 'vi'
  ? 'Bạn cần mở một bảng trước khi thao tác với cột hoặc card.'
  : 'Open a board first before working with columns or cards.'

// Tìm board của user theo title (không phân biệt hoa thường), trả về { board, matches }
const resolveUserBoardByTitle = async (userId, wantedTitle) => {
  const userBoards = await boardService.getBoards(userId, 1, 100)
  const wanted = String(wantedTitle || '').trim().toLowerCase()
  const matches = (userBoards?.boards || []).filter((b) => {
    const t = (b.title || '').toLowerCase()
    return t === wanted || t.includes(wanted) || wanted.includes(t)
  })
  return { board: matches[0] || null, matches }
}

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
  } else if (aiResult.action === 'UPDATE_COLUMN_TITLE' && aiResult.payload?.columnTitle && aiResult.payload?.newTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const column = (boardContext.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('Column not found in the current board')
      const newTitle = String(aiResult.payload.newTitle).trim()
      if (!newTitle) throw new Error('New column title is empty')
      await columnService.update(userId, column._id.toString(), { title: newTitle })
      actionResult = { type: 'COLUMN_UPDATED', data: { columnId: column._id.toString(), title: newTitle } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📝 Đã đổi tên cột thành "' + newTitle + '"' : '📝 Column renamed to "' + newTitle + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ARCHIVE_COLUMN' && aiResult.payload?.columnTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const column = (boardContext.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('Column not found in the current board')
      await columnService.archiveColumn(userId, column._id.toString())
      actionResult = { type: 'COLUMN_ARCHIVED', data: { columnId: column._id.toString(), title: column.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📦 Đã lưu trữ cột "' + column.title + '" (có thể khôi phục)' : '📦 Column "' + column.title + '" archived (restorable)')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'RESTORE_COLUMN' && aiResult.payload?.columnTitle) {
    try {
      if (!currentBoardId) throw new Error(noBoardMsg(language))
      const archived = await boardService.getArchivedItems(userId, currentBoardId)
      const column = (archived.columns || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.columnTitle).toLowerCase())
      if (!column) throw new Error('No archived column matching that title')
      await columnService.restoreColumn(userId, column._id.toString())
      actionResult = { type: 'COLUMN_RESTORED', data: { columnId: column._id.toString(), title: column.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📂 Đã khôi phục cột "' + column.title + '"' : '📂 Column "' + column.title + '" restored')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'UPDATE_CARD' && aiResult.payload?.cardTitle && (aiResult.payload?.newTitle || aiResult.payload?.newDescription)) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || []).map((c) => ({ ...c, columnTitle: col.title }))).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      const updateData = {}
      if (aiResult.payload.newTitle) updateData.title = String(aiResult.payload.newTitle).trim()
      if (aiResult.payload.newDescription !== undefined) updateData.description = String(aiResult.payload.newDescription)
      if (Object.keys(updateData).length === 0) throw new Error('Nothing to update')
      await cardService.update(card._id.toString(), updateData, undefined, { _id: userId })
      actionResult = { type: 'CARD_UPDATED', data: { cardId: card._id.toString(), title: updateData.title || card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📝 Đã cập nhật card "' + (updateData.title || card.title) + '"' : '📝 Card "' + (updateData.title || card.title) + '" updated')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'ARCHIVE_CARD' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId || !boardContext) throw new Error(noBoardMsg(language))
      const card = (boardContext.columns || []).flatMap((col) => (col.cards || [])).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('Card not found in the current board')
      await cardService.archiveCard(userId, card._id.toString())
      actionResult = { type: 'CARD_ARCHIVED', data: { cardId: card._id.toString(), title: card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📦 Đã lưu trữ card "' + card.title + '" (có thể khôi phục)' : '📦 Card "' + card.title + '" archived (restorable)')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'RESTORE_CARD' && aiResult.payload?.cardTitle) {
    try {
      if (!currentBoardId) throw new Error(noBoardMsg(language))
      const archived = await boardService.getArchivedItems(userId, currentBoardId)
      const card = (archived.cards || []).find((c) => c.title.toLowerCase() === String(aiResult.payload.cardTitle).toLowerCase())
      if (!card) throw new Error('No archived card matching that title')
      await cardService.restoreCard(userId, card._id.toString())
      actionResult = { type: 'CARD_RESTORED', data: { cardId: card._id.toString(), title: card.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📂 Đã khôi phục card "' + card.title + '"' : '📂 Card "' + card.title + '" restored')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'INVITE_MEMBER' && aiResult.payload?.inviteeEmail) {
    try {
      const inviteeEmail = String(aiResult.payload.inviteeEmail).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteeEmail)) throw new Error('Invalid invitee email')
      let boardIdToInvite = currentBoardId
      let boardTitleToInvite = boardContext?.title || null
      if (!boardIdToInvite && aiResult.payload.boardTitle) {
        const resolved = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
        if (!resolved.board || resolved.matches.length > 1) throw new Error('Board not found or ambiguous')
        boardIdToInvite = resolved.board._id.toString()
        boardTitleToInvite = resolved.board.title
      }
      if (!boardIdToInvite) throw new Error(noBoardMsg(language))
      await invitationService.createNewBoardInvitation({ inviteeEmail, boardId: boardIdToInvite }, userId)
      actionResult = { type: 'MEMBER_INVITED', data: { inviteeEmail, boardTitle: boardTitleToInvite } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '📧 Đã gửi lời mời tới ' + inviteeEmail + ' vào bảng "' + (boardTitleToInvite || '') + '"' : '📧 Invitation sent to ' + inviteeEmail + ' for "' + (boardTitleToInvite || '') + '"')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'CLOSE_BOARD' && aiResult.payload?.boardTitle || currentBoardId) {
    try {
      let boardIdToClose = currentBoardId
      let boardTitleToClose = boardContext?.title || null
      if (aiResult.payload?.boardTitle) {
        const resolved = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
        if (!resolved.board || resolved.matches.length > 1) throw new Error('Board not found or ambiguous')
        boardIdToClose = resolved.board._id.toString()
        boardTitleToClose = resolved.board.title
      }
      if (!boardIdToClose) throw new Error(noBoardMsg(language))
      await boardService.closeBoard(userId, boardIdToClose)
      actionResult = { type: 'BOARD_CLOSED', data: { _id: boardIdToClose, title: boardTitleToClose } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '🔒 Đã đóng bảng "' + (boardTitleToClose || '') + '" (có thể mở lại)' : '🔒 Board "' + (boardTitleToClose || '') + '" closed (reopenable)')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
    }
  } else if (aiResult.action === 'REOPEN_BOARD' && aiResult.payload?.boardTitle) {
    try {
      const resolved2 = await resolveUserBoardByTitle(userId, aiResult.payload.boardTitle)
      if (!resolved2.board || resolved2.matches.length > 1) throw new Error('Board not found or ambiguous')
      await boardService.reopenBoard(userId, resolved2.board._id.toString())
      actionResult = { type: 'BOARD_REOPENED', data: { _id: resolved2.board._id.toString(), title: resolved2.board.title } }
      aiResult.message += NEWLINE2 + (language === 'vi' ? '🔓 Đã mở lại bảng "' + resolved2.board.title + '"' : '🔓 Board "' + resolved2.board.title + '" reopened')
    } catch (err) {
      aiResult.message += language === 'vi'
        ? NEWLINE2 + '*(Không thể thực hiện do: ' + err.message + ')*'
        : NEWLINE2 + '*(Could not complete the action due to: ' + err.message + ')*'
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
