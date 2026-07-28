export function compareCodePoints(leftValue, rightValue) {
  const left = String(leftValue);
  const right = String(rightValue);
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0);
    const rightPoint = rightPoints[index].codePointAt(0);
    if (leftPoint < rightPoint) return -1;
    if (leftPoint > rightPoint) return 1;
  }
  if (leftPoints.length < rightPoints.length) return -1;
  if (leftPoints.length > rightPoints.length) return 1;
  return 0;
}
