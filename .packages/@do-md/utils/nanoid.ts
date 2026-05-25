// import { customAlphabet } from 'nanoid'
import { customAlphabet } from 'nanoid/non-secure'

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const nanoid6 = customAlphabet(alphabet, 6)  // 62^6 = 56.8 billion combinations 
const nanoid8 = customAlphabet(alphabet, 8)  // 62^8 = 218 trillion combinations

function nanoid() {
  return nanoid8();
}

export { nanoid, nanoid6, nanoid8 }

