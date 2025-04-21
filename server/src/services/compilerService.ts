import { exec } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as temp from 'temp';
import { promisify } from 'util';

// Track and cleanup temporary files
temp.track();

// Promisify exec
const execAsync = promisify(exec);

// Define compiler result interface
export interface CompilerResult {
  output: string;
  error: string | null;
  executionTime: number;
}

// Define supported languages (all lowercase for consistency)
const SUPPORTED_LANGUAGES = new Set([
  'c', 'cpp', 'python', 'javascript', 
  'typescript', 'java', 'php', 'go',
  'html', 'css'
]);

// Time and memory limits
const EXECUTION_TIMEOUT = parseInt(process.env.TIMEOUT_MS || '10000');
const MAX_BUFFER_SIZE = parseInt(process.env.MAX_BUFFER_SIZE || '5242880'); // 5MB

/**
 * Normalize language ID to ensure consistent case handling
 */
const normalizeLanguageId = (language: string): string => {
  return language.toLowerCase().trim();
};

/**
 * Check if a language is supported
 */
export const isSupportedLanguage = (language: string): boolean => {
  return SUPPORTED_LANGUAGES.has(normalizeLanguageId(language));
};

/**
 * Check for basic syntax errors
 */
export const checkSyntax = (code: string, languageId: string): { hasError: boolean; errorMessage: string | null } => {
  // No code provided
  if (!code.trim()) {
    return {
      hasError: true,
      errorMessage: "No code to compile. Please enter some code.",
    };
  }

  // Simple pattern-based error checking based on language
  switch (languageId) {
    case "c":
    case "cpp": {
      // Missing main function
      if (!code.includes("main(") && !code.includes("main (")) {
        return {
          hasError: true,
          errorMessage: "Error: missing 'main' function. Every C/C++ program must have a main function.",
        };
      }
      
      // Missing semicolons (basic check)
      if (code.includes("printf(") && !code.includes(";")) {
        return {
          hasError: true,
          errorMessage: "Syntax Error: missing semicolon ';'",
        };
      }
      
      // Missing closing brackets - improved to ignore braces in comments and strings
      const cCodeWithoutStrings = code.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
                                     .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
                                     .replace(/\/\/.*$/gm, '') // Remove single line comments
                                     .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
      
      const cOpenBrackets = (cCodeWithoutStrings.match(/{/g) || []).length;
      const cCloseBrackets = (cCodeWithoutStrings.match(/}/g) || []).length;
      if (cOpenBrackets > cCloseBrackets) {
        return {
          hasError: true,
          errorMessage: `Error: missing closing curly brace '}'`,
        };
      }
      break;
    }

    case "python": {
      // Improved Python indentation error detection
      const lines = code.split('\n').filter(line => line.trim().length > 0);
      let previousIndent = 0;
      let inconsistentIndentation = false;
      
      for (const line of lines) {
        if (line.trim().startsWith('#')) continue; // Skip comment lines
        
        // Count leading spaces
        const indent = line.length - line.trimStart().length;
        
        // Check for indent consistency (must be multiple of either 2 or 4)
        if (indent > 0 && previousIndent > 0) {
          if (indent % 4 !== 0 && indent % 2 !== 0) {
            inconsistentIndentation = true;
            break;
          }
          
          // Check for mixed tab/space or inconsistent indentation level changes
          if (indent > previousIndent && (indent - previousIndent) % 2 !== 0 && 
             (indent - previousIndent) % 4 !== 0) {
            inconsistentIndentation = true;
            break;
          }
        }
        
        if (indent > 0) previousIndent = indent;
      }
      
      if (inconsistentIndentation) {
        return {
          hasError: true,
          errorMessage: "IndentationError: inconsistent indentation detected",
        };
      }
      break;
    }

    case "javascript":
    case "typescript": {
      // Missing closing brackets - improved to ignore braces in comments and strings
      const jsCodeWithoutStrings = code.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
                                      .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
                                      .replace(/\/\/.*$/gm, '') // Remove single line comments
                                      .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
      
      const jsOpenBrackets = (jsCodeWithoutStrings.match(/{/g) || []).length;
      const jsCloseBrackets = (jsCodeWithoutStrings.match(/}/g) || []).length;
      if (jsOpenBrackets > jsCloseBrackets) {
        return {
          hasError: true,
          errorMessage: "SyntaxError: missing closing curly brace '}'",
        };
      }
      
      // Improved string termination detection
      let inSingleQuote = false;
      let inDoubleQuote = false;
      let inTemplateLiteral = false;
      let escapeNext = false;
      let stringStartLine = 0;
      let currentLine = 1;
      let stringType = '';
      
      for (let i = 0; i < code.length; i++) {
        const char = code[i];
        
        // Track line numbers for better error reporting
        if (char === '\n') {
          currentLine++;
        }
        
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        
        if (!inSingleQuote && !inDoubleQuote && !inTemplateLiteral) {
          // Not inside any string
          if (char === "'") {
            inSingleQuote = true;
            stringStartLine = currentLine;
            stringType = 'single quote';
          }
          else if (char === '"') {
            inDoubleQuote = true;
            stringStartLine = currentLine;
            stringType = 'double quote';
          }
          else if (char === '`') {
            inTemplateLiteral = true;
            stringStartLine = currentLine;
            stringType = 'template literal';
          }
        } else if (inSingleQuote && char === "'") {
          inSingleQuote = false;
        } else if (inDoubleQuote && char === '"') {
          inDoubleQuote = false;
        } else if (inTemplateLiteral && char === '`') {
          inTemplateLiteral = false;
        }
      }

      // If we're still in a string at the end, we have an unterminated string
      if (inSingleQuote || inDoubleQuote || inTemplateLiteral) {
        return {
          hasError: true,
          errorMessage: `SyntaxError: unterminated ${stringType} starting at line ${stringStartLine}`,
        };
      }
      break;
    }
  }

  return { hasError: false, errorMessage: null };
};

/**
 * Execute code in the specified language
 */
export const executeCode = async (code: string, language: string): Promise<CompilerResult> => {
  const startTime = Date.now();
  
  try {
    switch (language) {
      case 'c':
        return await compileAndRunC(code);
      case 'cpp':
        return await compileAndRunCpp(code);
      case 'python':
        return await runPython(code);
      case 'javascript':
        return await runJavaScript(code);
      case 'typescript':
        return await runTypeScript(code);
      case 'java':
        return await compileAndRunJava(code);
      case 'php':
        return await runPhp(code);
      case 'go':
        return await compileAndRunGo(code);
      default:
        return simulateExecution(code, language);
    }
  } catch (error: unknown) {
    console.error(`Execution error for ${language}:`, error);
    
    return {
      output: '',
      error: error instanceof Error ? error.message : 'Unknown execution error',
      executionTime: Date.now() - startTime
    };
  }
};

/**
 * Compile and run C code
 */
async function compileAndRunC(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('c-compiler');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.c');
    const outputPath = path.join(tmpDir, 'main.out');
    
    await fs.writeFile(sourcePath, code);
    
    // Compile the code
    try {
      await execAsync(`gcc ${sourcePath} -o ${outputPath} -lm`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string };
      return {
        output: '',
        error: err.stderr || 'Compilation error',
        executionTime: Date.now() - startTime
      };
    }
    
    // Execute the compiled code
    try {
      const { stdout, stderr } = await execAsync(`${outputPath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Compile and run C++ code
 */
async function compileAndRunCpp(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('cpp-compiler');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.cpp');
    const outputPath = path.join(tmpDir, 'main.out');
    
    await fs.writeFile(sourcePath, code);
    
    // Compile the code
    try {
      await execAsync(`g++ ${sourcePath} -o ${outputPath} -std=c++17`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string };
      return {
        output: '',
        error: err.stderr || 'Compilation error',
        executionTime: Date.now() - startTime
      };
    }
    
    // Execute the compiled code
    try {
      const { stdout, stderr } = await execAsync(`${outputPath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Run Python code
 */
async function runPython(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('python-runner');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.py');
    
    await fs.writeFile(sourcePath, code);
    
    // Execute the Python code
    try {
      const { stdout, stderr } = await execAsync(`python3 ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Run JavaScript code using Node.js
 */
async function runJavaScript(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('javascript-runner');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.js');
    
    await fs.writeFile(sourcePath, code);
    
    // Execute the JavaScript code
    try {
      const { stdout, stderr } = await execAsync(`node ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Run TypeScript code
 */
async function runTypeScript(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('typescript-runner');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.ts');
    
    await fs.writeFile(sourcePath, code);
    
    // Execute the TypeScript code with ts-node
    try {
      const { stdout, stderr } = await execAsync(`npx ts-node ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Compile and run Java code
 */
async function compileAndRunJava(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Check for class name
    const mainClassMatch = code.match(/public\s+class\s+(\w+)/);
    if (!mainClassMatch) {
      return {
        output: '',
        error: 'No public class found in the code',
        executionTime: Date.now() - startTime
      };
    }
    
    const mainClassName = mainClassMatch[1];
    
    // Create temporary directory
    const tmpDir = temp.mkdirSync('java-compiler');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, `${mainClassName}.java`);
    
    await fs.writeFile(sourcePath, code);
    
    // Compile the Java code
    try {
      await execAsync(`javac ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
    } catch (error: unknown) {
      const err = error as { stderr?: string };
      return {
        output: '',
        error: err.stderr || 'Compilation error',
        executionTime: Date.now() - startTime
      };
    }
    
    // Execute the compiled Java code
    try {
      const { stdout, stderr } = await execAsync(`java -cp ${tmpDir} ${mainClassName}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Run PHP code
 */
async function runPhp(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('php-runner');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.php');
    
    await fs.writeFile(sourcePath, code);
    
    // Execute the PHP code
    try {
      const { stdout, stderr } = await execAsync(`php ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Compile and run Go code
 */
async function compileAndRunGo(code: string): Promise<CompilerResult> {
  const startTime = Date.now();
  
  try {
    // Create temporary directory
    const tmpDir = temp.mkdirSync('go-compiler');
    
    // Write the code to a temporary file
    const sourcePath = path.join(tmpDir, 'main.go');
    
    await fs.writeFile(sourcePath, code);
    
    // Execute the Go code (combining compilation and execution)
    try {
      const { stdout, stderr } = await execAsync(`go run ${sourcePath}`, {
        timeout: EXECUTION_TIMEOUT,
        maxBuffer: MAX_BUFFER_SIZE
      });
      
      return {
        output: stdout,
        error: stderr || null,
        executionTime: Date.now() - startTime
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string, stderr?: string };
      return {
        output: err.stdout || '',
        error: err.stderr || 'Compilation or runtime error',
        executionTime: Date.now() - startTime
      };
    }
  } finally {
    // Cleanup will be handled by temp.track()
  }
}

/**
 * Simulate code execution for languages that can't be run directly
 * Used as a fallback for frontend-only languages or when no compiler is available
 */
function simulateExecution(code: string, languageId: string): CompilerResult {
  const startTime = Date.now();
  let output = "";

  // Extract print statements for simulated output
  switch (languageId) {
    case "c": 
    case "cpp": {
      // Extract printf or cout statements
      const printRegex = languageId === "c" 
        ? /printf\s*\(\s*"([^"]*)"/g
        : /cout\s*<<\s*"([^"]*)"/g;

      let match;
      while ((match = printRegex.exec(code)) !== null) {
        output += match[1] + "\n";
      }
      break;
    }
      
    case "python": {
      // Extract print statements
      const printRegex = /print\s*\(\s*(?:f?["']([^"']*)["']|([^)]*)\s*)\)/g;
      let match;
      while ((match = printRegex.exec(code)) !== null) {
        output += (match[1] || match[2] || "") + "\n";
      }
      break;
    }
      
    case "javascript":
    case "typescript": {
      // Extract console.log statements
      const consoleRegex = /console\.log\s*\(\s*(?:["']([^"']*)["']|([^)]*)\s*)\)/g;
      let match;
      while ((match = consoleRegex.exec(code)) !== null) {
        output += (match[1] || match[2] || "") + "\n";
      }
      break;
    }
      
    case "html":
    case "css":
      output = "Frontend code doesn't produce console output directly.\nRendering in the preview panel.";
      break;
      
    default:
      output = "Language execution simulation not implemented yet.\nProgram executed successfully.";
  }

  if (!output && languageId !== 'html' && languageId !== 'css') {
    output = "Program executed successfully with no output.";
  }

  return {
    output,
    error: null,
    executionTime: Date.now() - startTime
  };
}