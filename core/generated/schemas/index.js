
'use strict';

const commonSchemas = require('./common');
const chatSchemas = require('./chat');
const notesSchemas = require('./notes');
const tasksSchemas = require('./tasks');

module.exports = Object.assign(
  commonSchemas,
  chatSchemas,
  notesSchemas,
  tasksSchemas
);
