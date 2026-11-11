declare module '*.md?canvas-template' {
  const template: {
    name: string;
    description: string;
    tags: string[];
    prompt: string;
  };
  export default template;
}
