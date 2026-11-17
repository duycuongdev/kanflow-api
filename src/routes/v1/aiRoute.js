import express from 'express'
import { aiValidation } from '~/validations/aiValidation'
import { aiController } from '~/controllers/aiController'
import { authMiddleware } from '~/middlewares/authMiddleware'

const Router = express.Router()

Router.route('/chat')
  .post(authMiddleware.isAuthorized, aiValidation.chat, aiController.chat)

export const aiRouter = Router
