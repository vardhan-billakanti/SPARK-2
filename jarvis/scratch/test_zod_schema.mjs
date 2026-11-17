import { windowsServer } from '../bridge/windows.mjs';

function zodToOpenAiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) {
    return { type: 'object', properties: {} }
  }
  const properties = {}
  const required = []

  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'string'
    const desc = field.description || field.def?.description || ''
    const typeName = field._def?.typeName || field.type || field.def?.type

    if (typeName === 'ZodNumber' || typeName === 'number') type = 'number'
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'boolean'
    else if (typeName === 'ZodArray' || typeName === 'array') type = 'array'
    else if (typeName === 'ZodEnum' || typeName === 'enum') {
      properties[key] = { type: 'string', enum: field._def?.values || field.def?.values, description: desc }
      if (typeof field.isOptional === 'function' ? !field.isOptional() : field.type !== 'optional') required.push(key)
      continue
    }

    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')

    properties[key] = { type, description: desc }
    if (!isOpt) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

const ws = windowsServer({ allowWrites: false });
const toolDef = ws.instance._registeredTools['launch_app'];

console.log('Resulting OpenAI Schema:');
console.log(JSON.stringify(zodToOpenAiSchema(toolDef.inputSchema), null, 2));
