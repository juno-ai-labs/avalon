const studyIds = ["horizon-a", "horizon-b", "horizon-c", "horizon-d"];
const requestedStudy = window.location.hash.slice(1);

if (!studyIds.includes(requestedStudy)) {
  const randomStudy = studyIds[Math.floor(Math.random() * studyIds.length)];
  window.location.replace(`#${randomStudy}`);
}
