/**
 * Logger Module
 * Handles all logging for the application
 * Writes to console and file
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.logFile = process.env.LOG_FILE || './logs/app.log';
    this.initLogDirectory();
  }

  initLogDirectory() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  formatMessage(level, message) {
    return `[${this.getTimestamp()}] ${level}: ${message}`;
  }

  writeToFile(message) {
    try {
      fs.appendFileSync(this.logFile, message + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  info(message) {
    const formatted = this.formatMessage('INFO', message);
    console.log(`✓ ${formatted}`);
    this.writeToFile(formatted);
  }

  warn(message) {
    const formatted = this.formatMessage('WARN', message);
    console.warn(`⚠ ${formatted}`);
    this.writeToFile(formatted);
  }

  error(message, error = null) {
    const errorMsg = error ? `${message} - ${error.message}` : message;
    const formatted = this.formatMessage('ERROR', errorMsg);
    console.error(`✗ ${formatted}`);
    this.writeToFile(formatted);
    if (error && error.stack) {
      this.writeToFile(error.stack);
    }
  }

  debug(message) {
    if (this.logLevel === 'debug') {
      const formatted = this.formatMessage('DEBUG', message);
      console.log(`🔍 ${formatted}`);
      this.writeToFile(formatted);
    }
  }
}

module.exports = new Logger();
