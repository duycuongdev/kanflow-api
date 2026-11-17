import { StatusCodes } from 'http-status-codes'
import { aiService } from '~/services/aiService'

const chat = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const result = await aiService.chat(userId, req.body)
    res.status(StatusCodes.OK).json(result)
  } catch (error) {
    next(error)
  }
}

export const aiController = {
  chat
}
