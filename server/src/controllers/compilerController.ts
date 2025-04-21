import { Request, Response } from 'express';
import * as CompilerService from '../services/compilerService';

interface CompileRequest {
  code: string;
  language: string;
}

/**
 * Handle code compilation requests
 */
export const compileCode = async (req: Request, res: Response) => {
  try {
    const { code, language } = req.body as CompileRequest;
    
    // Validation
    if (!code || !language) {
      return res.status(400).json({
        success: false,
        error: 'Code and language are required'
      });
    }

    // Check if the language is supported
    if (!CompilerService.isSupportedLanguage(language)) {
      return res.status(400).json({
        success: false,
        error: `Language '${language}' is not supported`
      });
    }
    
    // Basic syntax check
    const syntaxCheck = CompilerService.checkSyntax(code, language);
    if (syntaxCheck.hasError) {
      return res.status(400).json({
        success: false,
        error: syntaxCheck.errorMessage,
      });
    }
    
    // Compile and execute the code
    const result = await CompilerService.executeCode(code, language);
    
    return res.status(200).json({
      success: true,
      output: result.output,
      error: result.error,
      executionTime: result.executionTime
    });
    
  } catch (error: unknown) {
    console.error('Error compiling code:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'An unexpected error occurred'
    });
  }
};