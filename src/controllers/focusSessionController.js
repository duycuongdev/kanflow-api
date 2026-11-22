import { StatusCodes } from 'http-status-codes'
import { focusSessionService } from '~/services/focusSessionService'

const createFocusSession = async (req, res, next) => {
  try {
    // User thực hiện request này chính là chủ nhân của phiên focus
    const userId = req.jwtDecoded._id

    const createdSession = await focusSessionService.createFocusSession(req.body, userId)

    res.status(StatusCodes.CREATED).json(createdSession)
  } catch (error) {
    next(error)
  }
}

const getFocusStats = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const { from, to } = req.query

    const stats = await focusSessionService.getMyFocusStats(userId, Number(from), Number(to))

    res.status(StatusCodes.OK).json(stats)
  } catch (error) {
    next(error)
  }
}

const getFocusLeaderboard = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const { from, to, page } = req.query

    const leaderboard = await focusSessionService.getLeaderboard(userId, Number(from), Number(to), Number(page) || 1)

    res.status(StatusCodes.OK).json(leaderboard)
  } catch (error) {
    next(error)
  }
}

export const focusSessionController = {
  createFocusSession,
  getFocusStats,
  getFocusLeaderboard
}
