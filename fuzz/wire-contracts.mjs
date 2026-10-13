import assert from 'node:assert/strict';
import { validDeviceId, validDeviceToken, validSwopClientId, validCommandEnvelope, validPlayerCommand, commandEndpointBase } from './.build/wire-contracts.js';

function validAscii(value, min, max, punctuation) {
  return value.length >= min && value.length <= max && [...value].every(char => {
    const code = char.charCodeAt(0);
    return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || punctuation.includes(char);
  });
}

export function fuzz(data) {
  if (data.length > 65536) return;
  const text = data.toString('utf8');
  assert.equal(validDeviceId(text), validAscii(text, 1, 128, '._:-'));
  assert.equal(validDeviceToken(text), validAscii(text, 32, 256, '_-'));
  assert.equal(validSwopClientId(text), validAscii(text, 8, 128, '._:-'));
  const suffixes = ['/api/webhook/commands', '/webhook/poll', '/webhook/notify'];
  const suffix = suffixes.find(value => text.endsWith(value));
  assert.equal(commandEndpointBase(text), suffix ? text.substring(0, text.length - suffix.length) : text);
  let value;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  const before = JSON.stringify(value);
  const expectedEnvelope = Boolean(value && Array.isArray(value.commands) && value.commands.length <= 256 && value.commands.every(item => item && typeof item === 'object' && typeof item.id === 'string' && validAscii(item.id, 1, 128, '_-')));
  assert.equal(validCommandEnvelope(value), expectedEnvelope);
  if (validPlayerCommand(value)) {
    assert.equal(typeof value.command, 'string');
    for (const key of ['volume','volume_step','popup_duration','channel_number','provider']) {
      if (value[key] !== undefined) assert.ok(typeof value[key] === 'number' && Number.isFinite(value[key]));
    }
    if (value.popup_duration !== undefined) assert.ok(value.popup_duration > 0 && value.popup_duration <= 3600);
    if (value.channel_number !== undefined) assert.ok(Number.isInteger(value.channel_number) && value.channel_number >= 1);
    if (value.provider !== undefined) assert.ok(Number.isInteger(value.provider) && value.provider >= 0);
    if (value.random_range !== undefined) {
      assert.equal(value.random_range.length, 2);
      assert.ok(value.random_range.every(item => Number.isInteger(item) && item >= 1));
      assert.ok(value.random_range[0] <= value.random_range[1]);
    }
  }
  assert.equal(JSON.stringify(value), before, 'wire validation must not mutate input');
}
