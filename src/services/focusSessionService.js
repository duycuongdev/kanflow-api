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

    const durationMs = reqBody.endedAt - reqBody.startedAt

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
 * Bảng xếp hạng focus trong khoảng [from, to):
 * - top: LEADERBOARD_LIMIT user có tổng focus cao nhất (kèm displayName/avatar)
 * - me: hạng + tổng focus của user hiện tại (dù nằm ngoài top)
 */
const getLeaderboard = async (userId, from, to) => {
  try {
    const totalsPerUser = await focusSessionModel.getTotalMsPerUserInRange(from, to)

    // Join thông tin user (chỉ lấy public fields) cho các user xuất hiện trong kỳ
    const userIds = totalsPerUser.map(t => t._id)
    const users = userIds.length > 0 ? await userModel.findManyByIds(userIds) : []
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

    const top = totalsPerUser.slice(0, LEADERBOARD_LIMIT).map(toRankRow)

    // Hạng của user hiện tại: số user có tổng cao hơn + 1 (nếu không có phiên nào trong kỳ thì hạng = null)
    const myIndex = totalsPerUser.findIndex(t => t._id.toString() === userId.toString())
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

    return { top, me, totalRankedUsers: totalsPerUser.length }
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
