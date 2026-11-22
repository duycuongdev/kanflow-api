import express from 'express'
import { focusSessionValidation } from '~/validations/focusSessionValidation'
import { focusSessionController } from '~/controllers/focusSessionController'
import { authMiddleware } from '~/middlewares/authMiddleware'
import { rateLimiterMiddleware } from '~/middlewares/rateLimiterMiddleware'

const Router = express.Router()

// Log 1 phiên focus khi kết thúc (chống spam log: giới hạn 60 phiên / 15 phút)
Router.route('/')
  .post(
    authMiddleware.isAuthorized,
    rateLimiterMiddleware.focusLimiter,
    focusSessionValidation.createNew,
    focusSessionController.createFocusSession
  )

// Thống kê focus của user hiện tại trong khoảng from/to (epoch ms)
Router.route('/stats')
  .get(authMiddleware.isAuthorized, focusSessionValidation.rangeQuery, focusSessionController.getFocusStats)

// Bảng xếp hạng focus toàn bộ user trong khoảng from/to (epoch ms)
Router.route('/leaderboard')
  .get(authMiddleware.isAuthorized, focusSessionValidation.rangeQuery, focusSessionController.getFocusLeaderboard)

export const focusSessionRoute = Router
