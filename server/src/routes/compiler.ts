import { Router } from 'express';
import { compileCode } from '../controllers/compilerController';

const router = Router();

/**
 * @route   POST /api/compiler/compile
 * @desc    Compile and execute code
 * @access  Public
 */
router.post('/compile', compileCode);

export default router;