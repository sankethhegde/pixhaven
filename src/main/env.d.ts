// electron-vite: "?modulePath" imports give the built file path of a worker entry.
declare module '*?modulePath' {
  const path: string;
  export default path;
}
