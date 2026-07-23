// The project doesn't install @types/multer. This shim lets us import the
// runtime helpers from 'multer' (bundled via @nestjs/platform-express) without
// a "missing declaration file" TypeScript error.
declare module 'multer';
