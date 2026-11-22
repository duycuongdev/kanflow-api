import { StatusCodes } from 'http-status-codes'
import ApiError from '~/utils/ApiError'
import { userModel } from '~/models/userModel'
import { focusSessionModel } from '~/models/focusSessionModel'

// Số người hiển thị trong bảng xếp hạng
const LEADERBOARD_LIMIT = 10

const createFocusSession = async (reqBody, userId) => {
  try {
    // Không cho phép log phiên focus "tương lai" (chặn client gửi sai dữ liệu)
    if (reqBody.startedAt > Date.now() + 5 * 60 * 1000) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Focus session cannot start in the future!')
    }

    if (!reqBody.endedAt || reqBody.endedAt <= reqBody.startedAt) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'endedAt must be greater than startedAt')
    }

    const durationMs = reqBody.endedAt - reqBody.startedAt
    if (durationMs < 60 * 1000 || durationMs > 4 * 60 * 60 * 1000) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid focus session duration: must be between 1 minute and 4 hours!')
    }

    const newSessionData = {
      userId: userId.toString(),
      startedAt: reqBody.startedAt,
      endedAt: reqBody.endedAt,
      durationMs,
      cardId: reqBody.cardId || null,
      boardId: reqBody.boardId || null
    }

    const createdSession = await focusSessionModel.createNew(newSessionData)
    const getSession = await focusSessionModel.findOneById(createdSession.insertedId)

    return getSession
  } catch (error) {
    throw error
  }
}

/**
 * Thống kê focus của chính user (tổng ms + số phiên) trong khoảng [from, to)
 */
const getMyFocusStats = async (userId, from, to) => {
  try {
    const summary = await focusSessionModel.sumDurationsByUserInRange(userId, from, to)

    return {
      totalMs: summary.totalMs || 0,
      sessionCount: summary.sessionCount || 0
    }
  } catch (error) {
    throw error
  }
}

/**
 * Bảng xếp hạng focus trong khoảng [from, to), phân trang theo page (mỗi trang LEADERBOARD_LIMIT user):
 * - top: các user của trang hiện tại (rank là hạng TOÀN CỤC, không theo trang)
 * - me: hạng + tổng focus của user hiện tại (dù nằm ngoài các trang)
 * - totalPages + hasMore để FE hiển thị navigation
 */
const getLeaderboard = async (userId, from, to, page = 1) => {
  try {
    const totalsPerUser = await focusSessionModel.getTotalMsPerUserInRange(from, to)
    const totalPages = Math.max(1, Math.ceil(totalsPerUser.length / LEADERBOARD_LIMIT))
    const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages)

    const pageStart = (currentPage - 1) * LEADERBOARD_LIMIT
    const pageItems = totalsPerUser.slice(pageStart, pageStart + LEADERBOARD_LIMIT)

    // Hạng của user hiện tại: số user có tổng cao hơn + 1 (nếu không có phiên nào trong kỳ thì hạng = null)
    const myIndex = totalsPerUser.findIndex(t => t._id.toString() === userId.toString())

    // Tối ưu hóa: Chỉ join thông tin user cho trang hiện tại + user hiện tại (tránh N+1 và bùng nổ RAM)
    const userIdsSet = new Set(pageItems.map(item => item._id.toString()))
    if (myIndex !== -1) {
      userIdsSet.add(totalsPerUser[myIndex]._id.toString())
    }
    const userIdsToFetch = Array.from(userIdsSet)
    const users = userIdsToFetch.length > 0 ? await userModel.findManyByIds(userIdsToFetch) : []
    const usersById = new Map(users.map(u => [u._id.toString(), u]))

    const toRankRow = (item, index) => {
      const user = usersById.get(item._id.toString())
      return {
        userId: item._id.toString(),
        displayName: user?.displayName || 'Unknown user',
        avatar: user?.avatar || null,
        totalMs: item.totalMs || 0,
        sessionCount: item.sessionCount || 0,
        rank: index + 1
      }
    }

    const top = pageItems.map((item, idx) => toRankRow(item, pageStart + idx))

    let me = null
    if (myIndex !== -1) {
      me = toRankRow(totalsPerUser[myIndex], myIndex)
    } else {
      const meUser = await userModel.findOneById(userId)
      me = {
        userId: userId.toString(),
        displayName: meUser?.displayName || 'Unknown user',
        avatar: meUser?.avatar || null,
        totalMs: 0,
        sessionCount: 0,
        rank: null
      }
    }

    return {
      top,
      me,
      totalRankedUsers: totalsPerUser.length,
      page: currentPage,
      totalPages,
      hasMore: currentPage < totalPages
    }
  } catch (error) {
    throw error
  }
}

export const focusSessionService = {
  createFocusSession,
  getMyFocusStats,
  getLeaderboard,
  LEADERBOARD_LIMIT
}
